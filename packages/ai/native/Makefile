UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  EXT = dylib
  CC = clang
else
  EXT = so
  CC = gcc
endif

CFLAGS = -O3 -ffast-math -fPIC -Wall -Wextra
LDFLAGS = -shared

TARGET = libmlp.$(EXT)

.PHONY: all clean

all: $(TARGET)

$(TARGET): mlp.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<

clean:
	rm -f $(TARGET)
