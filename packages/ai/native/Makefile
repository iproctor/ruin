UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  EXT = dylib
  CC = clang
else
  EXT = so
  CC = gcc
endif

CFLAGS = -O3 -fPIC -Wall -Wextra
# -ffast-math removed: it makes gcc emit calls to _ZGVbN4v_expf (vectorized
# expf in libmvec) for the sigmoid layer's expf calls, but libmvec isn't
# auto-linked, so dlopen(libmlp.so) fails on workers with "undefined symbol"
# at runtime. Without -ffast-math gcc keeps standard libm expf and the .so
# dlopens cleanly. Loses ~5% perf vs vectorized math, still 8-9× over JS.
LDFLAGS = -shared

TARGET = libmlp.$(EXT)

.PHONY: all clean

all: $(TARGET)

$(TARGET): mlp.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<

clean:
	rm -f $(TARGET)
