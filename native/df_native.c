// Flat C ABI over SDL3 + wgpu-native for scriptc FFI: scalars and byte spans only.
#include <SDL3/SDL.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>
#if defined(__APPLE__)
#include <SDL3/SDL_metal.h>
#include <TargetConditionals.h>
#endif

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_NO_STDIO
#include "third_party/stb_image.h"

#define DF_MAX_PIPELINES 64
#define DF_MAX_BUFFERS 1024
#define DF_MAX_BIND_GROUPS 1024
#define DF_MAX_TEXTURES 256

enum { DF_USAGE_VERTEX = 1, DF_USAGE_INDEX = 2, DF_USAGE_UNIFORM = 4 };
enum { DF_PIPELINE_DEPTH = 1, DF_PIPELINE_BLEND = 4 };
enum { DF_FORMAT_FLOAT32X2 = 0, DF_FORMAT_FLOAT32X3 = 1, DF_FORMAT_FLOAT32X4 = 2, DF_FORMAT_FLOAT32 = 3, DF_FORMAT_UNORM8X4 = 4 };

static SDL_Window *g_window;
static WGPUInstance g_instance;
static WGPUSurface g_surface;
static WGPUAdapter g_adapter;
static WGPUDevice g_device;
static WGPUQueue g_queue;
static WGPUTextureFormat g_format;
static WGPURenderPipeline g_pipelines[DF_MAX_PIPELINES];
static int32_t g_pipeline_count;
static WGPUBuffer g_buffers[DF_MAX_BUFFERS];
static int32_t g_buffer_count;
static WGPUBindGroup g_bind_groups[DF_MAX_BIND_GROUPS];
static int32_t g_bind_group_count;
static WGPUTexture g_textures[DF_MAX_TEXTURES];
static WGPUTextureView g_texture_views[DF_MAX_TEXTURES];
static int32_t g_texture_sizes[DF_MAX_TEXTURES][2];
static uint8_t g_texture_smooth[DF_MAX_TEXTURES];
static int32_t g_texture_count;
static WGPUSampler g_sampler;
static WGPUSampler g_sampler_linear;
static WGPUTexture g_depth_texture;
static WGPUTextureView g_depth_view;
static int g_width, g_height;
static WGPUPresentMode g_present_mode = WGPUPresentMode_Fifo;
#define DF_MAX_GAMEPADS 4
static SDL_Gamepad *g_gamepads[DF_MAX_GAMEPADS];

// In-flight frame state between df_begin and df_end.
static WGPUSurfaceTexture g_frame_texture;
static WGPUTextureView g_frame_view;
static WGPUCommandEncoder g_frame_encoder;
static WGPURenderPassEncoder g_frame_pass;

static void on_adapter(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void *ud1, void *ud2) {
  (void)ud2;
  if (status == WGPURequestAdapterStatus_Success) *(WGPUAdapter *)ud1 = adapter;
  else fprintf(stderr, "dotframe: adapter request failed: %.*s\n", (int)message.length, message.data);
}

static void on_device(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void *ud1, void *ud2) {
  (void)ud2;
  if (status == WGPURequestDeviceStatus_Success) *(WGPUDevice *)ud1 = device;
  else fprintf(stderr, "dotframe: device request failed: %.*s\n", (int)message.length, message.data);
}

static WGPUSurface create_surface(void) {
  WGPUSurfaceDescriptor desc = WGPU_SURFACE_DESCRIPTOR_INIT;
#if defined(__APPLE__)
  SDL_MetalView view = SDL_Metal_CreateView(g_window);
  WGPUSurfaceSourceMetalLayer src = WGPU_SURFACE_SOURCE_METAL_LAYER_INIT;
  src.layer = SDL_Metal_GetLayer(view);
  desc.nextInChain = &src.chain;
  return wgpuInstanceCreateSurface(g_instance, &desc);
#elif defined(_WIN32)
  SDL_PropertiesID props = SDL_GetWindowProperties(g_window);
  WGPUSurfaceSourceWindowsHWND src = WGPU_SURFACE_SOURCE_WINDOWS_HWND_INIT;
  src.hwnd = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WIN32_HWND_POINTER, NULL);
  src.hinstance = SDL_GetPointerProperty(props, SDL_PROP_WINDOW_WIN32_INSTANCE_POINTER, NULL);
  desc.nextInChain = &src.chain;
  return wgpuInstanceCreateSurface(g_instance, &desc);
#else
  return NULL;
#endif
}

static void configure_surface(void) {
  SDL_GetWindowSizeInPixels(g_window, &g_width, &g_height);
  WGPUSurfaceConfiguration config = WGPU_SURFACE_CONFIGURATION_INIT;
  config.device = g_device;
  config.format = g_format;
  config.usage = WGPUTextureUsage_RenderAttachment;
  config.width = (uint32_t)g_width;
  config.height = (uint32_t)g_height;
  config.presentMode = g_present_mode;
  config.alphaMode = WGPUCompositeAlphaMode_Auto;
  wgpuSurfaceConfigure(g_surface, &config);

  if (g_depth_view) wgpuTextureViewRelease(g_depth_view);
  if (g_depth_texture) wgpuTextureRelease(g_depth_texture);
  WGPUTextureDescriptor depth = WGPU_TEXTURE_DESCRIPTOR_INIT;
  depth.usage = WGPUTextureUsage_RenderAttachment;
  depth.size = (WGPUExtent3D){(uint32_t)g_width, (uint32_t)g_height, 1};
  depth.format = WGPUTextureFormat_Depth24Plus;
  g_depth_texture = wgpuDeviceCreateTexture(g_device, &depth);
  g_depth_view = wgpuTextureCreateView(g_depth_texture, NULL);
}

int32_t df_open(int32_t width, int32_t height, const uint8_t *title, size_t title_len) {
  char title_buf[256];
  size_t n = title_len < sizeof title_buf - 1 ? title_len : sizeof title_buf - 1;
  memcpy(title_buf, title, n);
  title_buf[n] = 0;

  if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD)) return -1;
  SDL_WindowFlags flags = SDL_WINDOW_HIGH_PIXEL_DENSITY | SDL_WINDOW_RESIZABLE;
#if defined(__APPLE__)
  flags |= SDL_WINDOW_METAL;
#endif
#if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
  flags |= SDL_WINDOW_FULLSCREEN | SDL_WINDOW_BORDERLESS;
#endif
  g_window = SDL_CreateWindow(title_buf, width, height, flags);
  if (!g_window) return -2;
  // A freshly launched game should take focus, so keyboard and mouse reach it.
  SDL_RaiseWindow(g_window);

  g_instance = wgpuCreateInstance(NULL);
  g_surface = create_surface();
  if (!g_surface) return -3;

  WGPURequestAdapterOptions adapter_opts = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
  adapter_opts.compatibleSurface = g_surface;
  WGPURequestAdapterCallbackInfo adapter_cb = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
  adapter_cb.mode = WGPUCallbackMode_AllowSpontaneous;
  adapter_cb.callback = on_adapter;
  adapter_cb.userdata1 = &g_adapter;
  wgpuInstanceRequestAdapter(g_instance, &adapter_opts, adapter_cb);
  if (!g_adapter) {
    // GPU-less machines (CI runners, VMs) may still expose a software adapter such as WARP.
    adapter_opts.forceFallbackAdapter = 1;
    wgpuInstanceRequestAdapter(g_instance, &adapter_opts, adapter_cb);
  }
  if (!g_adapter) return -4;
  WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;
  wgpuAdapterGetInfo(g_adapter, &info);
  fprintf(stderr, "dotframe: adapter %.*s (backend %d, type %d)\n", (int)info.device.length, info.device.data,
          (int)info.backendType, (int)info.adapterType);
  wgpuAdapterInfoFreeMembers(info);

  WGPURequestDeviceCallbackInfo device_cb = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
  device_cb.mode = WGPUCallbackMode_AllowSpontaneous;
  device_cb.callback = on_device;
  device_cb.userdata1 = &g_device;
  wgpuAdapterRequestDevice(g_adapter, NULL, device_cb);
  if (!g_device) return -5;
  g_queue = wgpuDeviceGetQueue(g_device);
  // Nearest filtering keeps pixel art crisp.
  WGPUSamplerDescriptor sampler = WGPU_SAMPLER_DESCRIPTOR_INIT;
  g_sampler = wgpuDeviceCreateSampler(g_device, &sampler);
  sampler.magFilter = WGPUFilterMode_Linear;
  sampler.minFilter = WGPUFilterMode_Linear;
  g_sampler_linear = wgpuDeviceCreateSampler(g_device, &sampler);

  WGPUSurfaceCapabilities caps = WGPU_SURFACE_CAPABILITIES_INIT;
  wgpuSurfaceGetCapabilities(g_surface, g_adapter, &caps);
  // Match the browser's preferred canvas format (non-sRGB) so colors agree across targets.
  // DF_VSYNC=0 uncaps the frame rate for benchmarks when the surface supports it.
  const char *vsync = SDL_getenv("DF_VSYNC");
  if (vsync && vsync[0] == '0') {
    for (size_t i = 0; i < caps.presentModeCount; i++) {
      if (caps.presentModes[i] == WGPUPresentMode_Immediate) g_present_mode = WGPUPresentMode_Immediate;
      else if (caps.presentModes[i] == WGPUPresentMode_Mailbox && g_present_mode != WGPUPresentMode_Immediate)
        g_present_mode = WGPUPresentMode_Mailbox;
    }
  }
  g_format = caps.formats[0];
  for (size_t i = 0; i < caps.formatCount; i++) {
    if (caps.formats[i] == WGPUTextureFormat_BGRA8Unorm || caps.formats[i] == WGPUTextureFormat_RGBA8Unorm) {
      g_format = caps.formats[i];
      break;
    }
  }
  wgpuSurfaceCapabilitiesFreeMembers(caps);
  configure_surface();
  return 0;
}

// SDL scancode, as listed in SDL_scancode.h.
uint8_t df_key_down(int32_t scancode) {
  int count = 0;
  const bool *state = SDL_GetKeyboardState(&count);
  return scancode >= 0 && scancode < count && state[scancode];
}

static SDL_Gamepad *gamepad_at(int32_t pad) { return pad >= 0 && pad < DF_MAX_GAMEPADS ? g_gamepads[pad] : NULL; }

// SDL_GamepadAxis on gamepad slot pad; returns [-1, 1], or 0 when the slot is empty.
double df_gamepad_axis(int32_t pad, int32_t axis) {
  SDL_Gamepad *gamepad = gamepad_at(pad);
  return gamepad ? SDL_GetGamepadAxis(gamepad, (SDL_GamepadAxis)axis) / 32767.0 : 0.0;
}

// SDL_GamepadButton on gamepad slot pad.
uint8_t df_gamepad_button(int32_t pad, int32_t button) {
  SDL_Gamepad *gamepad = gamepad_at(pad);
  return gamepad && SDL_GetGamepadButton(gamepad, (SDL_GamepadButton)button);
}

// Mouse position relative to the window's content, normalized to [0, 1] inside it (outside values extend past).
// Uses global state so the position does not depend on the window holding mouse focus.
static void mouse_relative(double *nx, double *ny) {
  float gx = 0, gy = 0;
  int wx = 0, wy = 0, w = 1, h = 1;
  SDL_GetGlobalMouseState(&gx, &gy);
  SDL_GetWindowPosition(g_window, &wx, &wy);
  SDL_GetWindowSize(g_window, &w, &h);
  *nx = w > 0 ? (gx - wx) / w : 0.0;
  *ny = h > 0 ? (gy - wy) / h : 0.0;
}

// Field 0 x, 1 y (normalized), 2 buttons (bit 0 left, bit 1 middle, bit 2 right).
double df_mouse(int32_t field) {
  if (field == 2) {
    SDL_MouseButtonFlags flags = SDL_GetGlobalMouseState(NULL, NULL);
    return (flags & SDL_BUTTON_LMASK ? 1 : 0) | (flags & SDL_BUTTON_MMASK ? 2 : 0) | (flags & SDL_BUTTON_RMASK ? 4 : 0);
  }
  double x, y;
  mouse_relative(&x, &y);
  return field == 0 ? x : y;
}

// Writes the per-user writable directory for org/app (UTF-8, trailing separator) into out; returns its length or -1.
int32_t df_pref_path(const uint8_t *org, size_t org_len, const uint8_t *app, size_t app_len, uint8_t *out, size_t out_len) {
  char org_buf[128], app_buf[128];
  size_t n = org_len < sizeof org_buf - 1 ? org_len : sizeof org_buf - 1;
  memcpy(org_buf, org, n);
  org_buf[n] = 0;
  n = app_len < sizeof app_buf - 1 ? app_len : sizeof app_buf - 1;
  memcpy(app_buf, app, n);
  app_buf[n] = 0;
  char *path = SDL_GetPrefPath(org_buf, app_buf);
  if (!path) return -1;
  size_t len = strlen(path);
  if (len > out_len) {
    SDL_free(path);
    return -1;
  }
  memcpy(out, path, len);
  SDL_free(path);
  return (int32_t)len;
}

int32_t df_width(void) { return g_width; }
int32_t df_height(void) { return g_height; }

int32_t df_buffer(uint32_t usage, const uint8_t *data, size_t len) {
  if (g_buffer_count >= DF_MAX_BUFFERS) return -1;
  WGPUBufferDescriptor desc = WGPU_BUFFER_DESCRIPTOR_INIT;
  desc.size = (len + 3) & ~(size_t)3;
  desc.usage = WGPUBufferUsage_CopyDst;
  if (usage & DF_USAGE_VERTEX) desc.usage |= WGPUBufferUsage_Vertex;
  if (usage & DF_USAGE_INDEX) desc.usage |= WGPUBufferUsage_Index;
  if (usage & DF_USAGE_UNIFORM) desc.usage |= WGPUBufferUsage_Uniform;
  WGPUBuffer buffer = wgpuDeviceCreateBuffer(g_device, &desc);
  if (!buffer) return -2;
  if (len) wgpuQueueWriteBuffer(g_queue, buffer, 0, data, len);
  g_buffers[g_buffer_count] = buffer;
  return g_buffer_count++;
}

void df_buffer_destroy(int32_t buffer) {
  if (buffer < 0 || buffer >= g_buffer_count || !g_buffers[buffer]) return;
  wgpuBufferRelease(g_buffers[buffer]);
  g_buffers[buffer] = NULL;
}

void df_buffer_write(int32_t buffer, const uint8_t *data, size_t len) {
  if (buffer < 0 || buffer >= g_buffer_count || !g_buffers[buffer]) return;
  wgpuQueueWriteBuffer(g_queue, g_buffers[buffer], 0, data, len);
}

// smooth selects linear filtering (fonts, photos) instead of nearest (pixel art).
int32_t df_texture(int32_t width, int32_t height, const uint8_t *rgba, size_t len, uint8_t smooth) {
  if (g_texture_count >= DF_MAX_TEXTURES || width <= 0 || height <= 0) return -1;
  if (len < (size_t)width * (size_t)height * 4) return -2;
  WGPUTextureDescriptor desc = WGPU_TEXTURE_DESCRIPTOR_INIT;
  desc.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
  desc.size = (WGPUExtent3D){(uint32_t)width, (uint32_t)height, 1};
  desc.format = WGPUTextureFormat_RGBA8Unorm;
  WGPUTexture texture = wgpuDeviceCreateTexture(g_device, &desc);
  WGPUTexelCopyTextureInfo dst = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
  dst.texture = texture;
  WGPUTexelCopyBufferLayout layout = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
  layout.bytesPerRow = (uint32_t)width * 4;
  layout.rowsPerImage = (uint32_t)height;
  wgpuQueueWriteTexture(g_queue, &dst, rgba, (size_t)width * (size_t)height * 4, &layout, &desc.size);
  int32_t id = g_texture_count++;
  g_textures[id] = texture;
  g_texture_views[id] = wgpuTextureCreateView(texture, NULL);
  g_texture_sizes[id][0] = width;
  g_texture_sizes[id][1] = height;
  g_texture_smooth[id] = smooth;
  return id;
}

// Decodes PNG bytes into a texture.
int32_t df_image(const uint8_t *png, size_t len, uint8_t smooth) {
  int width, height, channels;
  stbi_uc *pixels = stbi_load_from_memory(png, (int)len, &width, &height, &channels, 4);
  if (!pixels) return -3;
  int32_t id = df_texture(width, height, pixels, (size_t)width * (size_t)height * 4, smooth);
  stbi_image_free(pixels);
  return id;
}

// axis 0 width, 1 height.
int32_t df_texture_size(int32_t texture, int32_t axis) {
  return texture >= 0 && texture < g_texture_count ? g_texture_sizes[texture][axis ? 1 : 0] : 0;
}

// attrs: little-endian u32 triples (format, offset, shaderLocation).
int32_t df_pipeline(const uint8_t *wgsl, size_t wgsl_len, uint32_t stride, const uint8_t *attrs, size_t attrs_len,
                    uint32_t flags) {
  if (g_pipeline_count >= DF_MAX_PIPELINES) return -1;
  WGPUShaderSourceWGSL src = WGPU_SHADER_SOURCE_WGSL_INIT;
  src.code = (WGPUStringView){(const char *)wgsl, wgsl_len};
  WGPUShaderModuleDescriptor module_desc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  module_desc.nextInChain = &src.chain;
  WGPUShaderModule module = wgpuDeviceCreateShaderModule(g_device, &module_desc);

  WGPUVertexAttribute attributes[16];
  size_t attribute_count = attrs_len / 12;
  if (attribute_count > 16) attribute_count = 16;
  for (size_t i = 0; i < attribute_count; i++) {
    const uint32_t *t = (const uint32_t *)(attrs + i * 12);
    static const WGPUVertexFormat formats[] = {WGPUVertexFormat_Float32x2, WGPUVertexFormat_Float32x3,
                                               WGPUVertexFormat_Float32x4, WGPUVertexFormat_Float32,
                                               WGPUVertexFormat_Unorm8x4};
    attributes[i] = (WGPUVertexAttribute)WGPU_VERTEX_ATTRIBUTE_INIT;
    attributes[i].format = t[0] <= DF_FORMAT_UNORM8X4 ? formats[t[0]] : WGPUVertexFormat_Float32x3;
    attributes[i].offset = t[1];
    attributes[i].shaderLocation = t[2];
  }
  WGPUVertexBufferLayout layout = WGPU_VERTEX_BUFFER_LAYOUT_INIT;
  layout.arrayStride = stride;
  layout.attributeCount = attribute_count;
  layout.attributes = attributes;

  WGPUBlendState blend = WGPU_BLEND_STATE_INIT;
  blend.color = (WGPUBlendComponent){WGPUBlendOperation_Add, WGPUBlendFactor_SrcAlpha, WGPUBlendFactor_OneMinusSrcAlpha};
  blend.alpha = (WGPUBlendComponent){WGPUBlendOperation_Add, WGPUBlendFactor_One, WGPUBlendFactor_OneMinusSrcAlpha};
  WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
  target.format = g_format;
  if (flags & DF_PIPELINE_BLEND) target.blend = &blend;
  WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
  fragment.module = module;
  fragment.entryPoint = (WGPUStringView){"fs_main", WGPU_STRLEN};
  fragment.targetCount = 1;
  fragment.targets = &target;

  WGPUDepthStencilState depth = WGPU_DEPTH_STENCIL_STATE_INIT;
  depth.format = WGPUTextureFormat_Depth24Plus;
  depth.depthWriteEnabled = WGPUOptionalBool_True;
  depth.depthCompare = WGPUCompareFunction_Less;

  WGPURenderPipelineDescriptor desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
  desc.vertex.module = module;
  desc.vertex.entryPoint = (WGPUStringView){"vs_main", WGPU_STRLEN};
  if (stride > 0) {
    desc.vertex.bufferCount = 1;
    desc.vertex.buffers = &layout;
  }
  desc.fragment = &fragment;
  if (flags & DF_PIPELINE_DEPTH) {
    desc.depthStencil = &depth;
    desc.primitive.cullMode = WGPUCullMode_Back;
  }
  WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(g_device, &desc);
  wgpuShaderModuleRelease(module);
  if (!pipeline) return -2;
  g_pipelines[g_pipeline_count] = pipeline;
  return g_pipeline_count++;
}

// Group 0 of the pipeline's auto layout: binding 0 uniform buffer, binding 1 texture, binding 2 sampler.
// Pass -1 for a resource the shader does not declare.
int32_t df_bind(int32_t pipeline, int32_t buffer, int32_t texture) {
  if (pipeline < 0 || pipeline >= g_pipeline_count) return -1;
  if (g_bind_group_count >= DF_MAX_BIND_GROUPS) return -2;
  WGPUBindGroupEntry entries[3];
  size_t count = 0;
  if (buffer >= 0 && buffer < g_buffer_count) {
    entries[count] = (WGPUBindGroupEntry)WGPU_BIND_GROUP_ENTRY_INIT;
    entries[count].binding = 0;
    entries[count].buffer = g_buffers[buffer];
    entries[count].size = wgpuBufferGetSize(g_buffers[buffer]);
    count++;
  }
  if (texture >= 0 && texture < g_texture_count) {
    entries[count] = (WGPUBindGroupEntry)WGPU_BIND_GROUP_ENTRY_INIT;
    entries[count].binding = 1;
    entries[count].textureView = g_texture_views[texture];
    count++;
    entries[count] = (WGPUBindGroupEntry)WGPU_BIND_GROUP_ENTRY_INIT;
    entries[count].binding = 2;
    entries[count].sampler = g_texture_smooth[texture] ? g_sampler_linear : g_sampler;
    count++;
  }
  WGPUBindGroupDescriptor desc = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
  desc.layout = wgpuRenderPipelineGetBindGroupLayout(g_pipelines[pipeline], 0);
  desc.entryCount = count;
  desc.entries = entries;
  WGPUBindGroup group = wgpuDeviceCreateBindGroup(g_device, &desc);
  wgpuBindGroupLayoutRelease(desc.layout);
  g_bind_groups[g_bind_group_count] = group;
  return g_bind_group_count++;
}

#define DF_MAX_TOUCHES 10

typedef struct {
  SDL_FingerID id;
  float x;
  float y;
} Touch;

static Touch g_touches[DF_MAX_TOUCHES];
static int32_t g_touch_count;
static uint8_t g_quit;

static void touch_set(SDL_FingerID id, float x, float y) {
  for (int32_t i = 0; i < g_touch_count; i++) {
    if (g_touches[i].id == id) {
      g_touches[i].x = x;
      g_touches[i].y = y;
      return;
    }
  }
  if (g_touch_count < DF_MAX_TOUCHES) g_touches[g_touch_count++] = (Touch){id, x, y};
}

static void touch_remove(SDL_FingerID id) {
  for (int32_t i = 0; i < g_touch_count; i++) {
    if (g_touches[i].id == id) {
      g_touches[i] = g_touches[--g_touch_count];
      return;
    }
  }
}

// Applies one SDL event. Desktop builds call it from df_poll; hosts using SDL main callbacks (iOS) call it from
// SDL_AppEvent.
void df_handle_event(const SDL_Event *event) {
  switch (event->type) {
    case SDL_EVENT_QUIT:
    case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
      g_quit = 1;
      break;
    case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
      configure_surface();
      break;
    case SDL_EVENT_FINGER_DOWN:
    case SDL_EVENT_FINGER_MOTION:
      touch_set(event->tfinger.fingerID, event->tfinger.x, event->tfinger.y);
      break;
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_CANCELED:
      touch_remove(event->tfinger.fingerID);
      break;
    case SDL_EVENT_GAMEPAD_ADDED:
      // Gamepads keep the first free slot they get, so player 1 stays player 1 across reconnects of others.
      for (int i = 0; i < DF_MAX_GAMEPADS; i++) {
        if (!g_gamepads[i]) {
          g_gamepads[i] = SDL_OpenGamepad(event->gdevice.which);
          break;
        }
      }
      break;
    case SDL_EVENT_GAMEPAD_REMOVED:
      for (int i = 0; i < DF_MAX_GAMEPADS; i++) {
        if (g_gamepads[i] && SDL_GetGamepadID(g_gamepads[i]) == event->gdevice.which) {
          SDL_CloseGamepad(g_gamepads[i]);
          g_gamepads[i] = NULL;
        }
      }
      break;
    default:
      break;
  }
}

// Drains pending events; returns false once the window is asked to close.
uint8_t df_poll(void) {
  SDL_Event event;
  while (SDL_PollEvent(&event)) df_handle_event(&event);
  return !g_quit;
}

int32_t df_touch_count(void) { return g_touch_count; }

// Field of touch i: 0 stable id while the finger stays down, 1 x and 2 y normalized to the window.
double df_touch(int32_t i, int32_t field) {
  if (i < 0 || i >= g_touch_count) return field == 0 ? -1.0 : 0.0;
  return field == 0 ? (double)g_touches[i].id : field == 1 ? g_touches[i].x : g_touches[i].y;
}

int32_t df_begin(double r, double g, double b, uint8_t use_depth) {
  g_frame_texture = (WGPUSurfaceTexture)WGPU_SURFACE_TEXTURE_INIT;
  wgpuSurfaceGetCurrentTexture(g_surface, &g_frame_texture);
  if (g_frame_texture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
      g_frame_texture.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
    if (g_frame_texture.texture) wgpuTextureRelease(g_frame_texture.texture);
    configure_surface();
    // No drawable (window hidden or occluded): the frame is skipped, but buffer writes made for it are already
    // queued and their staging is only reclaimed after a submit. Submit nothing so they apply and recycle;
    // otherwise a hidden window grows by one frame's uploads per frame (gigabytes per second at 50k sprites).
    WGPUSubmissionIndex submitted = wgpuQueueSubmitForIndex(g_queue, 0, NULL);
    wgpuDevicePoll(g_device, 1, &submitted);
    return 1;
  }
  g_frame_view = wgpuTextureCreateView(g_frame_texture.texture, NULL);
  g_frame_encoder = wgpuDeviceCreateCommandEncoder(g_device, NULL);

  WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
  color.view = g_frame_view;
  color.loadOp = WGPULoadOp_Clear;
  color.storeOp = WGPUStoreOp_Store;
  color.clearValue = (WGPUColor){r, g, b, 1.0};
  WGPURenderPassDepthStencilAttachment depth = WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT;
  depth.view = g_depth_view;
  depth.depthLoadOp = WGPULoadOp_Clear;
  depth.depthStoreOp = WGPUStoreOp_Store;
  depth.depthClearValue = 1.0f;
  WGPURenderPassDescriptor pass_desc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
  pass_desc.colorAttachmentCount = 1;
  pass_desc.colorAttachments = &color;
  if (use_depth) pass_desc.depthStencilAttachment = &depth;
  g_frame_pass = wgpuCommandEncoderBeginRenderPass(g_frame_encoder, &pass_desc);
  return 0;
}

// Negative handles mean "none". first/count are indices with an index buffer (uint32), vertices otherwise.
void df_draw(int32_t pipeline, int32_t bind_group, int32_t vertex_buffer, int32_t index_buffer, uint32_t first,
             uint32_t count) {
  if (!g_frame_pass || pipeline < 0 || pipeline >= g_pipeline_count) return;
  wgpuRenderPassEncoderSetPipeline(g_frame_pass, g_pipelines[pipeline]);
  if (bind_group >= 0 && bind_group < g_bind_group_count)
    wgpuRenderPassEncoderSetBindGroup(g_frame_pass, 0, g_bind_groups[bind_group], 0, NULL);
  if (vertex_buffer >= 0 && vertex_buffer < g_buffer_count)
    wgpuRenderPassEncoderSetVertexBuffer(g_frame_pass, 0, g_buffers[vertex_buffer], 0, WGPU_WHOLE_SIZE);
  if (index_buffer >= 0 && index_buffer < g_buffer_count) {
    wgpuRenderPassEncoderSetIndexBuffer(g_frame_pass, g_buffers[index_buffer], WGPUIndexFormat_Uint32, 0,
                                        WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(g_frame_pass, count, 1, first, 0, 0);
  } else {
    wgpuRenderPassEncoderDraw(g_frame_pass, count, 1, first, 0);
  }
}

void df_end(void) {
  if (!g_frame_pass) return;
  wgpuRenderPassEncoderEnd(g_frame_pass);
  wgpuRenderPassEncoderRelease(g_frame_pass);
  g_frame_pass = NULL;
  WGPUCommandBuffer commands = wgpuCommandEncoderFinish(g_frame_encoder, NULL);
  wgpuQueueSubmit(g_queue, 1, &commands);
  wgpuSurfacePresent(g_surface);
  wgpuCommandBufferRelease(commands);
  wgpuCommandEncoderRelease(g_frame_encoder);
  wgpuTextureViewRelease(g_frame_view);
  wgpuTextureRelease(g_frame_texture.texture);
}

void df_audio_close(void);

void df_close(void) {
  df_audio_close();
  for (int32_t i = 0; i < g_bind_group_count; i++) wgpuBindGroupRelease(g_bind_groups[i]);
  for (int32_t i = 0; i < g_buffer_count; i++)
    if (g_buffers[i]) wgpuBufferRelease(g_buffers[i]);
  for (int32_t i = 0; i < g_texture_count; i++) {
    wgpuTextureViewRelease(g_texture_views[i]);
    wgpuTextureRelease(g_textures[i]);
  }
  if (g_sampler) wgpuSamplerRelease(g_sampler);
  if (g_sampler_linear) wgpuSamplerRelease(g_sampler_linear);
  for (int32_t i = 0; i < g_pipeline_count; i++) wgpuRenderPipelineRelease(g_pipelines[i]);
  if (g_depth_view) wgpuTextureViewRelease(g_depth_view);
  if (g_depth_texture) wgpuTextureRelease(g_depth_texture);
  if (g_queue) wgpuQueueRelease(g_queue);
  if (g_device) wgpuDeviceRelease(g_device);
  if (g_adapter) wgpuAdapterRelease(g_adapter);
  if (g_surface) wgpuSurfaceRelease(g_surface);
  if (g_instance) wgpuInstanceRelease(g_instance);
  for (int i = 0; i < DF_MAX_GAMEPADS; i++)
    if (g_gamepads[i]) SDL_CloseGamepad(g_gamepads[i]);
  if (g_window) SDL_DestroyWindow(g_window);
  SDL_Quit();
}
