// Software mixer over an SDL3 audio stream: decoded sound effects, square tones and one streamed music track.
// All entry points are called from the game thread; the SDL callback mixes on the audio thread under g_lock.
// df_sound decodes on a worker thread: it returns the id at once, and voices on a sound still decoding wait silent.
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
  // 16-bit PCM in the file's own channel count (1 or 2): a quarter of float stereo for mono sounds.
  int16_t *frames;
  uint64_t count;
  uint32_t rate;
  uint32_t channels;
} Sound;

typedef struct {
  int32_t sound;
  double position;
  // Playback rate; the step per output frame also needs the sound's sample rate, known once it decodes.
  double speed;
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

// Music channels play streamed tracks at the same time (layered scores: a drone, a tension bed, a climax), each with
// its own loop, pause and volume.
#define MUSIC_CHANNELS 4
typedef struct {
  drmp3 mp3;
  int open;
  int loop;
  int paused;
  float volume;
  float buffer[4096 * 2];
  uint64_t buffered;
  double position;
  double step;
} Music;
static Music g_music[MUSIC_CHANNELS];
static float g_master = 0.8f;

// Sample of channel c (0 left, 1 right) at frame i; mono sounds feed both channels.
static float sample(const Sound *sound, uint64_t i, int c) {
  return sound->frames[i * sound->channels + (sound->channels > 1 ? (uint64_t)c : 0)] * (1.0f / 32768.0f);
}

static float clampf(float v) { return v < -1.0f ? -1.0f : v > 1.0f ? 1.0f : v; }

// Pulls a channel's next frame pair through a small linear resampler; returns 0 at the end of a non-looping track.
static int music_frame(Music *m, float *left, float *right) {
  while (m->position + 1.0 >= (double)m->buffered) {
    if (m->buffered >= 1) {
      // Keep the last frame so interpolation stays continuous across refills.
      m->buffer[0] = m->buffer[(m->buffered - 1) * 2];
      m->buffer[1] = m->buffer[(m->buffered - 1) * 2 + 1];
      m->position -= (double)(m->buffered - 1);
      m->buffered = 1;
    }
    uint64_t read = drmp3_read_pcm_frames_f32(&m->mp3, 4095, m->buffer + m->buffered * 2);
    if (read == 0) {
      if (!m->loop || !drmp3_seek_to_pcm_frame(&m->mp3, 0)) return 0;
      read = drmp3_read_pcm_frames_f32(&m->mp3, 4095, m->buffer + m->buffered * 2);
      if (read == 0) return 0;
    }
    m->buffered += read;
  }
  uint64_t i = (uint64_t)m->position;
  float t = (float)(m->position - (double)i);
  *left = m->buffer[i * 2] * (1 - t) + m->buffer[(i + 1) * 2] * t;
  *right = m->buffer[i * 2 + 1] * (1 - t) + m->buffer[(i + 1) * 2 + 1] * t;
  m->position += m->step;
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
      if (sound->count == 0) {
        v++;
        continue;
      }
      double step = (double)sound->rate / OUTPUT_RATE * voice->speed;
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
        out[f * 2] += (sample(sound, i, 0) * (1 - t) + sample(sound, i + 1, 0) * t) * voice->volume * voice->left;
        out[f * 2 + 1] += (sample(sound, i, 1) * (1 - t) + sample(sound, i + 1, 1) * t) * voice->volume * voice->right;
        voice->position += step;
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
    for (int c = 0; c < MUSIC_CHANNELS; c++) {
      Music *m = &g_music[c];
      if (!m->open || m->paused) continue;
      for (int f = 0; f < frames; f++) {
        float left, right;
        if (!music_frame(m, &left, &right)) {
          drmp3_uninit(&m->mp3);
          m->open = 0;
          break;
        }
        out[f * 2] += left * m->volume;
        out[f * 2 + 1] += right * m->volume;
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

typedef struct {
  int32_t id;
  uint8_t *mp3;
  size_t len;
} DecodeJob;

// Decodes still running, so closing waits for them before freeing the sounds and the lock.
static SDL_AtomicInt g_decoding;

static int SDLCALL decode(void *data) {
  DecodeJob *job = data;
  drmp3_config config;
  drmp3_uint64 count = 0;
  drmp3_int16 *decoded = drmp3_open_memory_and_read_pcm_frames_s16(job->mp3, job->len, &config, &count, NULL);
  free(job->mp3);
  if (decoded) {
    uint32_t channels = config.channels > 1 ? 2 : 1;
    int16_t *frames = malloc(sizeof(int16_t) * channels * (size_t)count);
    if (frames) {
      for (drmp3_uint64 i = 0; i < count; i++)
        for (uint32_t c = 0; c < channels; c++) frames[i * channels + c] = decoded[i * config.channels + c];
      SDL_LockMutex(g_lock);
      g_sounds[job->id] = (Sound){frames, count, config.sampleRate, channels};
      SDL_UnlockMutex(g_lock);
    }
    drmp3_free(decoded, NULL);
  }
  free(job);
  SDL_AddAtomicInt(&g_decoding, -1);
  return 0;
}

// Takes MP3 bytes for a playable sound: copies them, decodes on a worker thread and returns the id right away.
// A sound that fails to decode stays silent.
int32_t df_sound(const uint8_t *mp3, size_t len) {
  if (g_sound_count >= MAX_SOUNDS || !g_lock) return -1;
  DecodeJob *job = malloc(sizeof *job);
  uint8_t *copy = malloc(len);
  if (!job || !copy) {
    free(job);
    free(copy);
    return -3;
  }
  memcpy(copy, mp3, len);
  SDL_LockMutex(g_lock);
  int32_t id = g_sound_count++;
  g_sounds[id] = (Sound){NULL, 0, OUTPUT_RATE, 1};
  SDL_UnlockMutex(g_lock);
  *job = (DecodeJob){id, copy, len};
  SDL_AddAtomicInt(&g_decoding, 1);
  SDL_Thread *thread = SDL_CreateThread(decode, "df-mp3", job);
  if (thread) SDL_DetachThread(thread);
  else decode(job);
  return id;
}

void df_play(int32_t sound, double volume, double rate) {
  if (!g_stream || sound < 0 || sound >= g_sound_count) return;
  SDL_LockMutex(g_lock);
  if (g_voice_count < MAX_VOICES) {
    g_voices[g_voice_count++] =
        (Voice){sound, 0.0, rate, (float)volume, 1.0f, 1.0f, 0, 0};
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

static Music *channel(int32_t c) { return c >= 0 && c < MUSIC_CHANNELS ? &g_music[c] : NULL; }

int32_t df_music_play_on(int32_t c, int32_t track, uint8_t loop, double volume) {
  Music *m = channel(c);
  if (!g_stream || !m || track < 0 || track >= g_track_count) return -1;
  SDL_LockMutex(g_lock);
  if (m->open) drmp3_uninit(&m->mp3);
  m->open = drmp3_init_memory(&m->mp3, g_tracks[track].data, g_tracks[track].size, NULL);
  m->loop = loop;
  m->paused = 0;
  m->volume = (float)volume;
  m->buffered = 0;
  m->position = 0;
  m->step = m->open ? (double)m->mp3.sampleRate / OUTPUT_RATE : 1.0;
  SDL_UnlockMutex(g_lock);
  return m->open ? 0 : -2;
}

static void music_stop_on(int32_t c) {
  Music *m = channel(c);
  if (!m) return;
  SDL_LockMutex(g_lock);
  if (m->open) drmp3_uninit(&m->mp3);
  m->open = 0;
  SDL_UnlockMutex(g_lock);
}

static void music_pause_on(int32_t c, uint8_t paused) {
  Music *m = channel(c);
  if (!m) return;
  SDL_LockMutex(g_lock);
  m->paused = paused;
  SDL_UnlockMutex(g_lock);
}

static void music_volume_on(int32_t c, double volume) {
  Music *m = channel(c);
  if (!m) return;
  SDL_LockMutex(g_lock);
  m->volume = (float)volume;
  SDL_UnlockMutex(g_lock);
}

int32_t df_music_play(int32_t track, uint8_t loop, double volume) { return df_music_play_on(0, track, loop, volume); }
void df_music_stop(void) { music_stop_on(0); }
void df_music_pause(uint8_t paused) { music_pause_on(0, paused); }
void df_music_volume(double volume) { music_volume_on(0, volume); }

void df_master_volume(double volume) { g_master = (float)volume; }

// Number of currently mixing sound and tone voices, for tests and diagnostics.
int32_t df_audio_active(void) {
  SDL_LockMutex(g_lock);
  int32_t active = g_voice_count + g_tone_count;
  for (int c = 0; c < MUSIC_CHANNELS; c++) active += g_music[c].open && !g_music[c].paused ? 1 : 0;
  SDL_UnlockMutex(g_lock);
  return active;
}

void df_audio_close(void) {
  while (SDL_GetAtomicInt(&g_decoding) > 0) SDL_Delay(1);
  if (g_stream) SDL_DestroyAudioStream(g_stream);
  g_stream = NULL;
  for (int c = 0; c < MUSIC_CHANNELS; c++) {
    if (g_music[c].open) drmp3_uninit(&g_music[c].mp3);
    g_music[c].open = 0;
  }
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
      g_voices[g_voice_count++] = (Voice){sound, 0.0, c, (float)b, 1.0f, 1.0f, (uint8_t)(d != 0), result};
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
// op / 8 picks the music channel (0 to 3) for ops 0 to 3, so layered scores need no more host callbacks.
int32_t df_music(int32_t op, double a, double b, double c) {
  int32_t ch = op / 8;
  op %= 8;
  if (op == 0) return df_music_play_on(ch, (int32_t)a, b != 0, c);
  if (op == 1) music_stop_on(ch);
  else if (op == 2) music_pause_on(ch, a != 0);
  else if (op == 3) music_volume_on(ch, a);
  else if (op == 4) df_master_volume(a);
  return 0;
}
