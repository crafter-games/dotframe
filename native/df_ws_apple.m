// WebSocket client for the native relay transport on macOS and iOS, over NSURLSessionWebSocketTask (TLS included).
// The game polls from its frame: open, state, send, then next/byte/pop to read a message one byte at a time, since
// scriptc library mode (iOS) cannot hand C a buffer to fill. Built with ARC.
#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#if TARGET_OS_IPHONE
#import <UIKit/UIKit.h>
#endif
#include <SDL3/SDL.h>

enum { DF_WS_CONNECTING = 0, DF_WS_OPEN = 1, DF_WS_CLOSED = 2, DF_WS_ERROR = 3 };

// DF_WS_DEBUG=1 logs socket events and errors to stderr.
static void ws_log(NSString *format, ...) {
  if (!getenv("DF_WS_DEBUG")) return;
  va_list args;
  va_start(args, format);
  NSString *line = [[NSString alloc] initWithFormat:format arguments:args];
  va_end(args);
  fprintf(stderr, "df_ws: %s\n", line.UTF8String);
}

@interface DFSocket : NSObject <NSURLSessionWebSocketDelegate>
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionWebSocketTask *task;
@property(nonatomic, strong) NSMutableArray<NSData *> *inbox;
@property(atomic) int32_t state;
@end

@implementation DFSocket
- (void)receive {
  __weak DFSocket *weakSelf = self;
  [self.task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    DFSocket *socket = weakSelf;
    if (!socket) return;
    if (error) {
      ws_log(@"receive failed: %@", error);
      if (socket.state != DF_WS_CLOSED) socket.state = DF_WS_ERROR;
      return;
    }
    NSData *data = message.type == NSURLSessionWebSocketMessageTypeString ? [message.string dataUsingEncoding:NSUTF8StringEncoding] : message.data;
    @synchronized(socket.inbox) {
      [socket.inbox addObject:data ?: [NSData data]];
    }
    [socket receive];
  }];
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didOpenWithProtocol:(NSString *)protocol {
  ws_log(@"open");
  self.state = DF_WS_OPEN;
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didCloseWithCode:(NSURLSessionWebSocketCloseCode)closeCode reason:(NSData *)reason {
  self.state = DF_WS_CLOSED;
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (error) ws_log(@"task failed: %@", error);
  if (error && self.state != DF_WS_CLOSED) self.state = DF_WS_ERROR;
}
@end

static NSMutableArray *g_sockets;

static DFSocket *socket_at(int32_t handle) {
  if (!g_sockets || handle < 0 || handle >= (int32_t)g_sockets.count) return nil;
  id entry = g_sockets[handle];
  return entry == [NSNull null] ? nil : (DFSocket *)entry;
}

// Returns a socket id; poll df_ws_state until it is open (1), closed (2) or failed (3).
static int32_t df_ws_open(const uint8_t *url, size_t len) {
  @autoreleasepool {
    if (!g_sockets) g_sockets = [NSMutableArray array];
    NSString *text = [[NSString alloc] initWithBytes:url length:len encoding:NSUTF8StringEncoding];
    NSURL *target = text ? [NSURL URLWithString:text] : nil;
    if (!target) return -1;
    DFSocket *socket = [DFSocket new];
    socket.inbox = [NSMutableArray array];
    socket.state = DF_WS_CONNECTING;
    socket.session = [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration defaultSessionConfiguration] delegate:socket delegateQueue:nil];
    socket.task = [socket.session webSocketTaskWithURL:target];
    ws_log(@"connecting to %@", target);
    [socket.task resume];
    [socket receive];
    [g_sockets addObject:socket];
    return (int32_t)g_sockets.count - 1;
  }
}

static int32_t df_ws_state(int32_t handle) {
  DFSocket *socket = socket_at(handle);
  return socket ? socket.state : DF_WS_CLOSED;
}

// Sends one text frame. Returns 0, or -1 when the socket is not open.
static int32_t df_ws_send(int32_t handle, const uint8_t *data, size_t len) {
  @autoreleasepool {
    DFSocket *socket = socket_at(handle);
    if (!socket || socket.state != DF_WS_OPEN) return -1;
    NSString *text = [[NSString alloc] initWithBytes:data length:len encoding:NSUTF8StringEncoding];
    if (!text) return -2;
    __weak DFSocket *weakSocket = socket;
    [socket.task sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:text] completionHandler:^(NSError *error) {
      if (error && weakSocket && weakSocket.state != DF_WS_CLOSED) weakSocket.state = DF_WS_ERROR;
    }];
    return 0;
  }
}

// Length in bytes of the oldest unread message, or -1 when there is none.
static int32_t df_ws_next(int32_t handle) {
  DFSocket *socket = socket_at(handle);
  if (!socket) return -1;
  @synchronized(socket.inbox) {
    return socket.inbox.count > 0 ? (int32_t)socket.inbox[0].length : -1;
  }
}

// Byte `index` of the oldest unread message, or -1 past its end.
static int32_t df_ws_byte(int32_t handle, int32_t index) {
  DFSocket *socket = socket_at(handle);
  if (!socket) return -1;
  @synchronized(socket.inbox) {
    if (socket.inbox.count == 0) return -1;
    NSData *data = socket.inbox[0];
    if (index < 0 || (NSUInteger)index >= data.length) return -1;
    return ((const uint8_t *)data.bytes)[index];
  }
}

// Drops the oldest unread message.
static void df_ws_pop(int32_t handle) {
  DFSocket *socket = socket_at(handle);
  if (!socket) return;
  @synchronized(socket.inbox) {
    if (socket.inbox.count > 0) [socket.inbox removeObjectAtIndex:0];
  }
}

static void df_ws_close(int32_t handle) {
  DFSocket *socket = socket_at(handle);
  if (!socket) return;
  socket.state = DF_WS_CLOSED;
  [socket.task cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
  [socket.session invalidateAndCancel];
  g_sockets[handle] = (id)[NSNull null];
}

// Shares text (a room link): the system share sheet on iOS, the clipboard on macOS. Returns 1 for the share sheet,
// 2 for the clipboard, 0 on failure.
static int32_t df_share(const uint8_t *text, size_t len) {
  @autoreleasepool {
    NSString *value = [[NSString alloc] initWithBytes:text length:len encoding:NSUTF8StringEncoding];
    if (!value) return 0;
#if TARGET_OS_IPHONE
    UIViewController *root = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if ([scene isKindOfClass:UIWindowScene.class]) root = ((UIWindowScene *)scene).keyWindow.rootViewController;
    }
    if (!root) return SDL_SetClipboardText(value.UTF8String) ? 2 : 0;
    UIActivityViewController *sheet = [[UIActivityViewController alloc] initWithActivityItems:@[ value ] applicationActivities:nil];
    // iPad presents the sheet as a popover, which needs an anchor.
    sheet.popoverPresentationController.sourceView = root.view;
    sheet.popoverPresentationController.sourceRect = CGRectMake(root.view.bounds.size.width / 2, root.view.bounds.size.height / 2, 1, 1);
    [root presentViewController:sheet animated:YES completion:nil];
    return 1;
#else
    return SDL_SetClipboardText(value.UTF8String) ? 2 : 0;
#endif
  }
}

// The exported surface is two calls, because scriptc library mode (iOS) caps a library at 32 host callbacks.
// op 0 opens text as a URL (returns a socket), 1 sends text on handle, 2 shares text.
int32_t df_ws_text(int32_t op, int32_t handle, const uint8_t *text, size_t len) {
  if (op == 0) return df_ws_open(text, len);
  if (op == 1) return df_ws_send(handle, text, len);
  if (op == 2) return df_share(text, len);
  return -1;
}

// op 0 state, 1 length of the next message, 2 byte arg of it, 3 drop it, 4 close.
int32_t df_ws(int32_t op, int32_t handle, int32_t arg) {
  if (op == 0) return df_ws_state(handle);
  if (op == 1) return df_ws_next(handle);
  if (op == 2) return df_ws_byte(handle, arg);
  if (op == 3) {
    df_ws_pop(handle);
    return 0;
  }
  if (op == 4) {
    df_ws_close(handle);
    return 0;
  }
  return -1;
}
