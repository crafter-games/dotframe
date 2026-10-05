// WebSocket client for the native relay transport on Windows, over WinHTTP (TLS included). Same surface as
// df_ws_apple.m: the game polls state, sends text frames, and reads messages one byte at a time. Connecting and
// receiving run on a worker thread per socket; a critical section guards the inbox.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <winhttp.h>
#include <SDL3/SDL.h>

enum { DF_WS_CONNECTING = 0, DF_WS_OPEN = 1, DF_WS_CLOSED = 2, DF_WS_ERROR = 3 };

typedef struct Message {
  uint8_t *data;
  int32_t len;
  struct Message *next;
} Message;

typedef struct {
  wchar_t url[2048];
  HINTERNET session, connection, request, socket;
  volatile LONG state;
  CRITICAL_SECTION lock;
  Message *head, *tail;
  HANDLE thread;
} Socket;

#define DF_MAX_SOCKETS 16
static Socket *g_sockets[DF_MAX_SOCKETS];

static Socket *socket_at(int32_t handle) {
  return handle >= 0 && handle < DF_MAX_SOCKETS ? g_sockets[handle] : NULL;
}

static void push(Socket *s, const uint8_t *data, int32_t len) {
  Message *m = (Message *)calloc(1, sizeof *m);
  if (!m) return;
  m->data = (uint8_t *)malloc(len > 0 ? (size_t)len : 1);
  if (!m->data) {
    free(m);
    return;
  }
  memcpy(m->data, data, (size_t)len);
  m->len = len;
  EnterCriticalSection(&s->lock);
  if (s->tail) s->tail->next = m;
  else s->head = m;
  s->tail = m;
  LeaveCriticalSection(&s->lock);
}

static DWORD WINAPI run(LPVOID arg) {
  Socket *s = (Socket *)arg;
  URL_COMPONENTS parts;
  memset(&parts, 0, sizeof parts);
  parts.dwStructSize = sizeof parts;
  wchar_t host[256], path[1792];
  parts.lpszHostName = host;
  parts.dwHostNameLength = 256;
  parts.lpszUrlPath = path;
  parts.dwUrlPathLength = 1792;
  wchar_t extra[1024];
  parts.lpszExtraInfo = extra;
  parts.dwExtraInfoLength = 1024;
  if (!WinHttpCrackUrl(s->url, 0, 0, &parts)) goto fail;
  // WinHttpCrackUrl knows ws:// and wss:// only as unknown schemes; decide TLS from the prefix.
  int secure = wcsncmp(s->url, L"wss://", 6) == 0;
  INTERNET_PORT port = parts.nPort ? parts.nPort : (secure ? 443 : 80);
  wchar_t target[2816];
  _snwprintf(target, 2816, L"%ls%ls", parts.dwUrlPathLength ? path : L"/", parts.dwExtraInfoLength ? extra : L"");
  s->session = WinHttpOpen(L"dotframe", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s->session) goto fail;
  s->connection = WinHttpConnect(s->session, host, port, 0);
  if (!s->connection) goto fail;
  s->request = WinHttpOpenRequest(s->connection, L"GET", target, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
  if (!s->request) goto fail;
  if (!WinHttpSetOption(s->request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, NULL, 0)) goto fail;
  if (!WinHttpSendRequest(s->request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, NULL, 0, 0, 0)) goto fail;
  if (!WinHttpReceiveResponse(s->request, NULL)) goto fail;
  s->socket = WinHttpWebSocketCompleteUpgrade(s->request, 0);
  if (!s->socket) goto fail;
  WinHttpCloseHandle(s->request);
  s->request = NULL;
  InterlockedExchange(&s->state, DF_WS_OPEN);
  // A message can arrive in fragments; collect until a non-fragment buffer type closes it.
  uint8_t chunk[4096];
  uint8_t *message = NULL;
  int32_t length = 0;
  for (;;) {
    DWORD read = 0;
    WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
    if (WinHttpWebSocketReceive(s->socket, chunk, sizeof chunk, &read, &type) != NO_ERROR) break;
    if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) break;
    uint8_t *grown = (uint8_t *)realloc(message, (size_t)length + read + 1);
    if (!grown) break;
    message = grown;
    memcpy(message + length, chunk, read);
    length += (int32_t)read;
    if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE || type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) {
      push(s, message, length);
      length = 0;
    }
  }
  free(message);
  if (s->state != DF_WS_CLOSED) InterlockedExchange(&s->state, DF_WS_CLOSED);
  return 0;
fail:
  InterlockedExchange(&s->state, DF_WS_ERROR);
  return 1;
}

static int32_t df_ws_open(const uint8_t *url, size_t len) {
  int32_t handle = -1;
  for (int32_t i = 0; i < DF_MAX_SOCKETS && handle < 0; i++)
    if (!g_sockets[i]) handle = i;
  if (handle < 0) return -1;
  Socket *s = (Socket *)calloc(1, sizeof *s);
  if (!s) return -1;
  int written = MultiByteToWideChar(CP_UTF8, 0, (const char *)url, (int)len, s->url, 2047);
  if (written <= 0) {
    free(s);
    return -1;
  }
  s->url[written] = 0;
  s->state = DF_WS_CONNECTING;
  InitializeCriticalSection(&s->lock);
  g_sockets[handle] = s;
  s->thread = CreateThread(NULL, 0, run, s, 0, NULL);
  if (!s->thread) s->state = DF_WS_ERROR;
  return handle;
}

static int32_t df_ws_state(int32_t handle) {
  Socket *s = socket_at(handle);
  return s ? (int32_t)s->state : DF_WS_CLOSED;
}

static int32_t df_ws_send(int32_t handle, const uint8_t *data, size_t len) {
  Socket *s = socket_at(handle);
  if (!s || s->state != DF_WS_OPEN) return -1;
  return WinHttpWebSocketSend(s->socket, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, (void *)data, (DWORD)len) == NO_ERROR ? 0 : -2;
}

static int32_t df_ws_next(int32_t handle) {
  Socket *s = socket_at(handle);
  if (!s) return -1;
  EnterCriticalSection(&s->lock);
  int32_t len = s->head ? s->head->len : -1;
  LeaveCriticalSection(&s->lock);
  return len;
}

static int32_t df_ws_byte(int32_t handle, int32_t index) {
  Socket *s = socket_at(handle);
  if (!s) return -1;
  EnterCriticalSection(&s->lock);
  int32_t value = s->head && index >= 0 && index < s->head->len ? s->head->data[index] : -1;
  LeaveCriticalSection(&s->lock);
  return value;
}

static void df_ws_pop(int32_t handle) {
  Socket *s = socket_at(handle);
  if (!s) return;
  EnterCriticalSection(&s->lock);
  Message *m = s->head;
  if (m) {
    s->head = m->next;
    if (!s->head) s->tail = NULL;
  }
  LeaveCriticalSection(&s->lock);
  if (m) {
    free(m->data);
    free(m);
  }
}

static void df_ws_close(int32_t handle) {
  Socket *s = socket_at(handle);
  if (!s) return;
  InterlockedExchange(&s->state, DF_WS_CLOSED);
  if (s->socket) WinHttpWebSocketClose(s->socket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, NULL, 0);
  if (s->thread) {
    WaitForSingleObject(s->thread, 2000);
    CloseHandle(s->thread);
  }
  if (s->socket) WinHttpCloseHandle(s->socket);
  if (s->request) WinHttpCloseHandle(s->request);
  if (s->connection) WinHttpCloseHandle(s->connection);
  if (s->session) WinHttpCloseHandle(s->session);
  while (s->head) df_ws_pop(handle);
  DeleteCriticalSection(&s->lock);
  free(s);
  g_sockets[handle] = NULL;
}

// No share sheet on Windows: the text goes to the clipboard. Returns 2 (clipboard) or 0.
static int32_t df_share(const uint8_t *text, size_t len) {
  char *value = (char *)malloc(len + 1);
  if (!value) return 0;
  memcpy(value, text, len);
  value[len] = 0;
  int ok = SDL_SetClipboardText(value);
  free(value);
  return ok ? 2 : 0;
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
