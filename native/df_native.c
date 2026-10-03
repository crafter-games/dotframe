// Flat C ABI over SDL3 + wgpu-native for scriptc FFI: scalars and byte spans only.
#include <SDL3/SDL.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <webgpu/webgpu.h>
#if defined(__APPLE__)
#include <SDL3/SDL_metal.h>
#endif

#define DF_MAX_PIPELINES 64

static SDL_Window *g_window;
static WGPUInstance g_instance;
static WGPUSurface g_surface;
static WGPUAdapter g_adapter;
static WGPUDevice g_device;
static WGPUQueue g_queue;
static WGPUTextureFormat g_format;
static WGPURenderPipeline g_pipelines[DF_MAX_PIPELINES];
static int32_t g_pipeline_count;
static int g_width, g_height;

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
  config.presentMode = WGPUPresentMode_Fifo;
  config.alphaMode = WGPUCompositeAlphaMode_Auto;
  wgpuSurfaceConfigure(g_surface, &config);
}

int32_t df_open(int32_t width, int32_t height, const uint8_t *title, size_t title_len) {
  char title_buf[256];
  size_t n = title_len < sizeof title_buf - 1 ? title_len : sizeof title_buf - 1;
  memcpy(title_buf, title, n);
  title_buf[n] = 0;

  if (!SDL_Init(SDL_INIT_VIDEO)) return -1;
  SDL_WindowFlags flags = SDL_WINDOW_HIGH_PIXEL_DENSITY | SDL_WINDOW_RESIZABLE;
#if defined(__APPLE__)
  flags |= SDL_WINDOW_METAL;
#endif
  g_window = SDL_CreateWindow(title_buf, width, height, flags);
  if (!g_window) return -2;

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
  if (!g_adapter) return -4;

  WGPURequestDeviceCallbackInfo device_cb = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
  device_cb.mode = WGPUCallbackMode_AllowSpontaneous;
  device_cb.callback = on_device;
  device_cb.userdata1 = &g_device;
  wgpuAdapterRequestDevice(g_adapter, NULL, device_cb);
  if (!g_device) return -5;
  g_queue = wgpuDeviceGetQueue(g_device);

  WGPUSurfaceCapabilities caps = WGPU_SURFACE_CAPABILITIES_INIT;
  wgpuSurfaceGetCapabilities(g_surface, g_adapter, &caps);
  // Match the browser's preferred canvas format (non-sRGB) so colors agree across targets.
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

int32_t df_pipeline(const uint8_t *wgsl, size_t wgsl_len) {
  if (g_pipeline_count >= DF_MAX_PIPELINES) return -1;
  WGPUShaderSourceWGSL src = WGPU_SHADER_SOURCE_WGSL_INIT;
  src.code = (WGPUStringView){(const char *)wgsl, wgsl_len};
  WGPUShaderModuleDescriptor module_desc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  module_desc.nextInChain = &src.chain;
  WGPUShaderModule module = wgpuDeviceCreateShaderModule(g_device, &module_desc);

  WGPUColorTargetState target = WGPU_COLOR_TARGET_STATE_INIT;
  target.format = g_format;
  WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
  fragment.module = module;
  fragment.entryPoint = (WGPUStringView){"fs_main", WGPU_STRLEN};
  fragment.targetCount = 1;
  fragment.targets = &target;

  WGPURenderPipelineDescriptor desc = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
  desc.vertex.module = module;
  desc.vertex.entryPoint = (WGPUStringView){"vs_main", WGPU_STRLEN};
  desc.fragment = &fragment;
  WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(g_device, &desc);
  wgpuShaderModuleRelease(module);
  if (!pipeline) return -2;
  g_pipelines[g_pipeline_count] = pipeline;
  return g_pipeline_count++;
}

// Returns false once the window is asked to close.
uint8_t df_poll(void) {
  SDL_Event event;
  while (SDL_PollEvent(&event)) {
    if (event.type == SDL_EVENT_QUIT || event.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED) return 0;
    if (event.type == SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED) configure_surface();
  }
  return 1;
}

int32_t df_frame(double r, double g, double b, int32_t pipeline, uint32_t vertex_count) {
  WGPUSurfaceTexture surface_tex = WGPU_SURFACE_TEXTURE_INIT;
  wgpuSurfaceGetCurrentTexture(g_surface, &surface_tex);
  if (surface_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
      surface_tex.status != WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
    if (surface_tex.texture) wgpuTextureRelease(surface_tex.texture);
    configure_surface();
    return 1;
  }
  WGPUTextureView view = wgpuTextureCreateView(surface_tex.texture, NULL);

  WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(g_device, NULL);
  WGPURenderPassColorAttachment color = WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
  color.view = view;
  color.loadOp = WGPULoadOp_Clear;
  color.storeOp = WGPUStoreOp_Store;
  color.clearValue = (WGPUColor){r, g, b, 1.0};
  WGPURenderPassDescriptor pass_desc = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
  pass_desc.colorAttachmentCount = 1;
  pass_desc.colorAttachments = &color;
  WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &pass_desc);
  if (pipeline >= 0 && pipeline < g_pipeline_count) {
    wgpuRenderPassEncoderSetPipeline(pass, g_pipelines[pipeline]);
    wgpuRenderPassEncoderDraw(pass, vertex_count, 1, 0, 0);
  }
  wgpuRenderPassEncoderEnd(pass);
  wgpuRenderPassEncoderRelease(pass);

  WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, NULL);
  wgpuQueueSubmit(g_queue, 1, &commands);
  wgpuSurfacePresent(g_surface);

  wgpuCommandBufferRelease(commands);
  wgpuCommandEncoderRelease(encoder);
  wgpuTextureViewRelease(view);
  wgpuTextureRelease(surface_tex.texture);
  return 0;
}

void df_close(void) {
  for (int32_t i = 0; i < g_pipeline_count; i++) wgpuRenderPipelineRelease(g_pipelines[i]);
  if (g_queue) wgpuQueueRelease(g_queue);
  if (g_device) wgpuDeviceRelease(g_device);
  if (g_adapter) wgpuAdapterRelease(g_adapter);
  if (g_surface) wgpuSurfaceRelease(g_surface);
  if (g_instance) wgpuInstanceRelease(g_instance);
  if (g_window) SDL_DestroyWindow(g_window);
  SDL_Quit();
}
