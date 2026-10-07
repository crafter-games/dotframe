// Software mixer over an SDL3 audio stream: decoded sound effects, square tones and one streamed music track.
// All entry points are called from the game thread; the SDL callback mixes on the audio thread under g_lock.
#include <SDL3/SDL.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define DR_MP3_IMPLEMENTATION
#include "third_party/dr_mp3.h"

#define OUTPUT_RATE 48000
#define MAX_SOUNDS 256
#define MAX_VOICES 64
#define MAX_TONES 16
#define MAX_TRACKS 32

typedef struct {
  float *frames;  // interleaved stereo
  uint64_t count;
  uint32_t rate;
} Sound;

typedef struct {
  int32_t sound;
  double position;
  double step;
  float volume;
  // Balance gains from the pan: 1 and 1 in the center, one side fading to 0 at -1 or 1.
  float left;
  float right;
  uint8_t loop;
  // Handle for df_voice; 0 for fire-and-forget df_play voices.
  int32_t id;
} Voice;

typedef struct {
  double phase;
  double step;
  double elapsed;
  double duration;
  float volume;
} Tone;

typedef struct {
  uint8_t *data;  // owned copy of the MP3 bytes the decoder streams from
  size_t size;
} Track;

static SDL_AudioStream *g_stream;
static SDL_Mutex *g_lock;
static Sound g_sounds[MAX_SOUNDS];
static int32_t g_sound_count;
static Voice g_voices[MAX_VOICES];
static int32_t g_voice_count;
static int32_t g_next_voice = 1;
static Tone g_tones[MAX_TONES];
static int32_t g_tone_count;
static Track g_tracks[MAX_TRACKS];
static int32_t g_track_count;

static drmp3 g_music;
static int g_music_open;
static int g_music_loop;
static int g_music_paused;
static float g_music_volume = 1.0f;
static float g_music_buffer[4096 * 2];
static uint64_t g_music_buffered;
static double g_music_position;
static double g_music_step;
static float g_master = 0.8f;

static float clampf(float v) { return v < -1.0f ? -1.0f : v > 1.0f ? 1.0f : v; }

// Pulls the next music frame pair through a small linear resampler; returns 0 at the end of a non-looping track.
static int music_frame(float *left, float *right) {
  while (g_music_position + 1.0 >= (double)g_music_buffered) {
    if (g_music_buffered >= 1) {
      // Keep the last frame so interpolation stays continuous across refills.
      g_music_buffer[0] = g_music_buffer[(g_music_buffered - 1) * 2];
      g_music_buffer[1] = g_music_buffer[(g_music_buffered - 1) * 2 + 1];
      g_music_position -= (double)(g_music_buffered - 1);
      g_music_buffered = 1;
    }
    uint64_t read = drmp3_read_pcm_frames_f32(&g_music, 4095, g_music_buffer + g_music_buffered * 2);
    if (read == 0) {
      if (!g_music_loop || !drmp3_seek_to_pcm_frame(&g_music, 0)) return 0;
      read = drmp3_read_pcm_frames_f32(&g_music, 4095, g_music_buffer + g_music_buffered * 2);
      if (read == 0) return 0;
    }
    g_music_buffered += read;
  }
  uint64_t i = (uint64_t)g_music_position;
  float t = (float)(g_music_position - (double)i);
  *left = g_music_buffer[i * 2] * (1 - t) + g_music_buffer[(i + 1) * 2] * t;
  *right = g_music_buffer[i * 2 + 1] * (1 - t) + g_music_buffer[(i + 1) * 2 + 1] * t;
  g_music_position += g_music_step;
  return 1;
}

static void SDLCALL mix(void *userdata, SDL_AudioStream *stream, int additional, int total) {
  (void)userdata;
  (void)total;
  float out[1024 * 2];
  while (additional > 0) {
    int frames = additional / (int)(sizeof(float) * 2);
    if (frames > 1024) frames = 1024;
    if (frames <= 0) break;
    memset(out, 0, sizeof(float) * 2 * (size_t)frames);
    SDL_LockMutex(g_lock);
    for (int32_t v = 0; v < g_voice_count;) {
      Voice *voice = &g_voices[v];
      Sound *sound = &g_sounds[voice->sound];
      int done = 0;
      for (int f = 0; f < frames; f++) {
        uint64_t i = (uint64_t)voice->position;
        if (i + 1 >= sound->count) {
          if (voice->loop && sound->count > 1) {
            voice->position -= (double)(sound->count - 1);
            i = (uint64_t)voice->position;
          } else {
            done = 1;
            break;
          }
        }
        float t = (float)(voice->position - (double)i);
        out[f * 2] += (sound->frames[i * 2] * (1 - t) + sound->frames[(i + 1) * 2] * t) * voice->volume * voice->left;
        out[f * 2 + 1] += (sound->frames[i * 2 + 1] * (1 - t) + sound->frames[(i + 1) * 2 + 1] * t) * voice->volume * voice->right;
        voice->position += voice->step;
      }
      if (done) g_voices[v] = g_voices[--g_voice_count];
      else v++;
    }
    for (int32_t k = 0; k < g_tone_count;) {
      Tone *tone = &g_tones[k];
      for (int f = 0; f < frames && tone->elapsed < tone->duration; f++) {
        // Exponential decay from volume to 0.1% over the duration, like Web Audio's exponentialRamp.
        float gain = tone->volume * powf(0.001f / tone->volume, (float)(tone->elapsed / tone->duration));
        float value = fmod(tone->phase, 1.0) < 0.5 ? gain : -gain;
        out[f * 2] += value;
        out[f * 2 + 1] += value;
        tone->phase += tone->step;
        tone->elapsed += 1.0 / OUTPUT_RATE;
      }
      if (tone->elapsed >= tone->duration) g_tones[k] = g_tones[--g_tone_count];
      else k++;
    }
    if (g_music_open && !g_music_paused) {
      for (int f = 0; f < frames; f++) {
        float left, right;
        if (!music_frame(&left, &right)) {
          drmp3_uninit(&g_music);
          g_music_open = 0;
          break;
        }
        out[f * 2] += left * g_music_volume;
        out[f * 2 + 1] += right * g_music_volume;
      }
    }
    SDL_UnlockMutex(g_lock);
    for (int f = 0; f < frames * 2; f++) out[f] = clampf(out[f] * g_master);
    SDL_PutAudioStreamData(stream, out, (int)(sizeof(float) * 2 * (size_t)frames));
    additional -= (int)(sizeof(float) * 2 * (size_t)frames);
  }
}

int32_t df_audio_open(void) {
  if (g_stream) return 0;
  if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) return -1;
  g_lock = SDL_CreateMutex();
  SDL_AudioSpec spec = {SDL_AUDIO_F32, 2, OUTPUT_RATE};
  g_stream = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, mix, NULL);
  if (!g_stream) return -2;
  SDL_ResumeAudioStreamDevice(g_stream);
  return 0;
}

// Decodes MP3 bytes into a playable sound.
int32_t df_sound(const uint8_t *mp3, size_t len) {
  if (g_sound_count >= MAX_SOUNDS) return -1;
  drmp3_config config;
  drmp3_uint64 count = 0;
  float *mono_or_stereo = drmp3_open_memory_and_read_pcm_frames_f32(mp3, len, &config, &count, NULL);
  if (!mono_or_stereo) return -2;
  float *frames = malloc(sizeof(float) * 2 * (size_t)count);
  for (drmp3_uint64 i = 0; i < count; i++) {
    frames[i * 2] = mono_or_stereo[i * config.channels];
    frames[i * 2 + 1] = mono_or_stereo[i * config.channels + (config.channels > 1 ? 1 : 0)];
  }
  drmp3_free(mono_or_stereo, NULL);
  SDL_LockMutex(g_lock);
  int32_t id = g_sound_count++;
  g_sounds[id] = (Sound){frames, count, config.sampleRate};
  SDL_UnlockMutex(g_lock);
  return id;
}

void df_play(int32_t sound, double volume, double rate) {
  if (!g_stream || sound < 0 || sound >= g_sound_count) return;
  SDL_LockMutex(g_lock);
  if (g_voice_count < MAX_VOICES) {
    g_voices[g_voice_count++] =
        (Voice){sound, 0.0, (double)g_sounds[sound].rate / OUTPUT_RATE * rate, (float)volume, 1.0f, 1.0f, 0, 0};
  }
  SDL_UnlockMutex(g_lock);
}

void df_tone(double frequency, double duration, double volume) {
  if (!g_stream || duration <= 0 || volume <= 0) return;
  SDL_LockMutex(g_lock);
  if (g_tone_count < MAX_TONES) g_tones[g_tone_count++] = (Tone){0.0, frequency / OUTPUT_RATE, 0.0, duration, (float)volume};
  SDL_UnlockMutex(g_lock);
}

// Keeps a copy of MP3 bytes for streaming playback.
int32_t df_track(const uint8_t *mp3, size_t len) {
  if (g_track_count >= MAX_TRACKS) return -1;
  uint8_t *copy = malloc(len);
  memcpy(copy, mp3, len);
  g_tracks[g_track_count] = (Track){copy, len};
  return g_track_count++;
}

int32_t df_music_play(int32_t track, uint8_t loop, double volume) {
  if (!g_stream || track < 0 || track >= g_track_count) return -1;
  SDL_LockMutex(g_lock);
  if (g_music_open) drmp3_uninit(&g_music);
  g_music_open = drmp3_init_memory(&g_music, g_tracks[track].data, g_tracks[track].size, NULL);
  g_music_loop = loop;
  g_music_paused = 0;
  g_music_volume = (float)volume;
  g_music_buffered = 0;
  g_music_position = 0;
  g_music_step = g_music_open ? (double)g_music.sampleRate / OUTPUT_RATE : 1.0;
  SDL_UnlockMutex(g_lock);
  return g_music_open ? 0 : -2;
}

void df_music_stop(void) {
  SDL_LockMutex(g_lock);
  if (g_music_open) drmp3_uninit(&g_music);
  g_music_open = 0;
  SDL_UnlockMutex(g_lock);
}

void df_music_pause(uint8_t paused) {
  SDL_LockMutex(g_lock);
  g_music_paused = paused;
  SDL_UnlockMutex(g_lock);
}

void df_music_volume(double volume) {
  SDL_LockMutex(g_lock);
  g_music_volume = (float)volume;
  SDL_UnlockMutex(g_lock);
}

void df_master_volume(double volume) { g_master = (float)volume; }

// Number of currently mixing sound and tone voices, for tests and diagnostics.
int32_t df_audio_active(void) {
  SDL_LockMutex(g_lock);
  int32_t active = g_voice_count + g_tone_count + (g_music_open && !g_music_paused ? 1 : 0);
  SDL_UnlockMutex(g_lock);
  return active;
}

void df_audio_close(void) {
  if (g_stream) SDL_DestroyAudioStream(g_stream);
  g_stream = NULL;
  if (g_music_open) drmp3_uninit(&g_music);
  g_music_open = 0;
  for (int32_t i = 0; i < g_sound_count; i++) free(g_sounds[i].frames);
  for (int32_t i = 0; i < g_track_count; i++) free(g_tracks[i].data);
  g_sound_count = g_track_count = g_voice_count = g_tone_count = 0;
  if (g_lock) SDL_DestroyMutex(g_lock);
  g_lock = NULL;
}

static Voice *find_voice(int32_t id) {
  for (int32_t v = 0; v < g_voice_count; v++)
    if (g_voices[v].id == id) return &g_voices[v];
  return NULL;
}

// One host call for controllable voices (scriptc library mode caps a library at 32 callbacks).
// op 0 starts sound a at volume b and rate c, looping when d != 0, and returns its id (0 when it cannot play).
// op 1 sets voice a to volume b and pan c (-1 left, 1 right). op 2 stops voice a. A finished voice ignores 1 and 2.
int32_t df_voice(int32_t op, double a, double b, double c, double d) {
  if (!g_stream) return 0;
  int32_t result = 0;
  SDL_LockMutex(g_lock);
  if (op == 0) {
    int32_t sound = (int32_t)a;
    if (sound >= 0 && sound < g_sound_count && g_voice_count < MAX_VOICES) {
      result = g_next_voice++;
      g_voices[g_voice_count++] = (Voice){sound, 0.0, (double)g_sounds[sound].rate / OUTPUT_RATE * c, (float)b, 1.0f, 1.0f, (uint8_t)(d != 0), result};
    }
  } else {
    Voice *voice = find_voice((int32_t)a);
    if (voice && op == 1) {
      float pan = (float)(c < -1 ? -1 : c > 1 ? 1 : c);
      voice->volume = (float)b;
      voice->left = pan > 0 ? 1.0f - pan : 1.0f;
      voice->right = pan < 0 ? 1.0f + pan : 1.0f;
    } else if (voice && op == 2) {
      *voice = g_voices[--g_voice_count];
    }
  }
  SDL_UnlockMutex(g_lock);
  return result;
}

// One host call for music and volume, because scriptc library mode (iOS) caps a library at 32 callbacks.
// op 0 plays track a (loop when b != 0) at volume c, 1 stops, 2 pauses (a != 0) or resumes, 3 sets the music volume
// to a, 4 sets the master volume to a. Returns df_music_play's result for op 0, else 0.
int32_t df_music(int32_t op, double a, double b, double c) {
  if (op == 0) return df_music_play((int32_t)a, b != 0, c);
  if (op == 1) df_music_stop();
  else if (op == 2) df_music_pause(a != 0);
  else if (op == 3) df_music_volume(a);
  else if (op == 4) df_master_volume(a);
  return 0;
}
