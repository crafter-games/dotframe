// Bakes a TTF into a signed-distance-field atlas (PNG, distance in alpha) plus JSON metrics.
// Build: cc -O2 tools/bake-font.c -o build/bake-font -lm
// Usage: build/bake-font <font.ttf> <out.png> <out.json> [pixel_height] [chars.txt]
// chars.txt (UTF-8) adds its characters to printable ASCII and the Latin set, for CJK or other scripts.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define STB_TRUETYPE_IMPLEMENTATION
#include "../native/third_party/stb_truetype.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "../native/third_party/stb_image_write.h"

#define ATLAS_WIDTH 1024
#define PADDING 8
#define ON_EDGE 128

static const int extra[] = {0xE1, 0xE9, 0xED, 0xF3, 0xFA, 0xC1, 0xC9, 0xCD, 0xD3, 0xDA,
                            0xF1, 0xD1, 0xA1, 0xBF, 0xFC, 0xDC, 0xB0, 0x2026, 0xD7,
                            0xB7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022};

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: %s <font.ttf> <out.png> <out.json> [pixel_height] [chars.txt]\n", argv[0]);
    return 2;
  }
  float pixel_height = argc > 4 ? (float)atof(argv[4]) : 64.0f;
  FILE *file = fopen(argv[1], "rb");
  if (!file) return 1;
  fseek(file, 0, SEEK_END);
  long size = ftell(file);
  fseek(file, 0, SEEK_SET);
  unsigned char *ttf = malloc((size_t)size);
  fread(ttf, 1, (size_t)size, file);
  fclose(file);

  stbtt_fontinfo font;
  if (!stbtt_InitFont(&font, ttf, stbtt_GetFontOffsetForIndex(ttf, 0))) return 1;
  float scale = stbtt_ScaleForPixelHeight(&font, pixel_height);
  int ascent, descent, line_gap;
  stbtt_GetFontVMetrics(&font, &ascent, &descent, &line_gap);

  static int codepoints[4096];
  int count = 0;
  for (int c = 32; c < 127; c++) codepoints[count++] = c;
  for (size_t i = 0; i < sizeof extra / sizeof extra[0]; i++) codepoints[count++] = extra[i];
  if (argc > 5) {
    FILE *chars = fopen(argv[5], "rb");
    if (!chars) return 1;
    int b;
    while ((b = fgetc(chars)) != EOF && count < 4096) {
      int cp = b, more = 0;
      if (b >= 0xF0) cp = b & 0x07, more = 3;
      else if (b >= 0xE0) cp = b & 0x0F, more = 2;
      else if (b >= 0xC0) cp = b & 0x1F, more = 1;
      while (more-- > 0 && (b = fgetc(chars)) != EOF) cp = (cp << 6) | (b & 0x3F);
      if (cp < 32) continue;
      int seen = 0;
      for (int i = 0; i < count && !seen; i++) seen = codepoints[i] == cp;
      if (!seen) codepoints[count++] = cp;
    }
    fclose(chars);
  }

  int atlas_height = 2048;
  unsigned char *atlas = calloc((size_t)ATLAS_WIDTH * atlas_height, 4);
  for (int i = 0; i < ATLAS_WIDTH * atlas_height; i++) {
    atlas[i * 4] = 255;
    atlas[i * 4 + 1] = 255;
    atlas[i * 4 + 2] = 255;
  }

  FILE *json = fopen(argv[3], "w");
  fprintf(json, "{\n  \"size\": %g,\n  \"ascent\": %g,\n  \"descent\": %g,\n  \"lineGap\": %g,\n  \"distanceRange\": %d,\n  \"glyphs\": [\n",
          pixel_height, ascent * scale, descent * scale, line_gap * scale, PADDING);
  int x = 0, y = 0, row_height = 0, used_height = 0, written = 0, missing = 0;
  for (int i = 0; i < count; i++) {
    int cp = codepoints[i];
    // A character the font lacks would bake its .notdef box; leave it out so Draw2D's fallback handles it.
    if (cp != 32 && stbtt_FindGlyphIndex(&font, cp) == 0) {
      missing++;
      continue;
    }
    int advance, lsb, w = 0, h = 0, xoff = 0, yoff = 0;
    stbtt_GetCodepointHMetrics(&font, cp, &advance, &lsb);
    unsigned char *sdf = stbtt_GetCodepointSDF(&font, scale, cp, PADDING, ON_EDGE, (float)ON_EDGE / PADDING, &w, &h, &xoff, &yoff);
    if (x + w + 1 > ATLAS_WIDTH) {
      x = 0;
      y += row_height + 1;
      row_height = 0;
    }
    for (int row = 0; row < h; row++)
      for (int col = 0; col < w; col++) atlas[((y + row) * ATLAS_WIDTH + x + col) * 4 + 3] = sdf[row * w + col];
    if (sdf) stbtt_FreeSDF(sdf, NULL);
    fprintf(json, "%s    { \"code\": %d, \"x\": %d, \"y\": %d, \"width\": %d, \"height\": %d, \"offsetX\": %d, \"offsetY\": %d, \"advance\": %g }",
            written++ > 0 ? ",\n" : "", cp, x, y, w, h, xoff, yoff, advance * scale);
    x += w + 1;
    if (h > row_height) row_height = h;
    if (y + row_height > used_height) used_height = y + row_height;
  }
  fprintf(json, "\n  ],\n  \"atlasWidth\": %d,\n  \"atlasHeight\": %d\n}\n", ATLAS_WIDTH, used_height);
  fclose(json);
  stbi_write_png(argv[2], ATLAS_WIDTH, used_height, 4, atlas, ATLAS_WIDTH * 4);
  printf("%s: %d glyphs, atlas %dx%d", argv[2], written, ATLAS_WIDTH, used_height);
  if (missing > 0) printf(", %d characters not in the font left out", missing);
  printf("\n");
  return 0;
}
