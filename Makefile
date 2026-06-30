PREFIX ?= /usr
LIBDIR ?= $(PREFIX)/lib/freeclaw
BINDIR ?= $(PREFIX)/bin
PNPM_VERSION ?= 11.5.2
PNPM ?= $(shell if command -v pnpm >/dev/null 2>&1; then command -v pnpm; elif command -v corepack >/dev/null 2>&1; then printf 'corepack pnpm'; else printf 'npx --yes pnpm@$(PNPM_VERSION)'; fi)

.PHONY: all build install ensure-pnpm

all: build

ensure-pnpm:
	@if command -v pnpm >/dev/null 2>&1; then \
		:; \
	elif command -v corepack >/dev/null 2>&1; then \
		corepack enable; \
		corepack prepare pnpm@$(PNPM_VERSION) --activate; \
	elif command -v npx >/dev/null 2>&1; then \
		:; \
	else \
		echo "pnpm is required; install pnpm or provide npm/npx for pnpm bootstrap" >&2; \
		exit 1; \
	fi

node_modules/.modules.yaml: pnpm-lock.yaml package.json pnpm-workspace.yaml | ensure-pnpm
	$(PNPM) install --frozen-lockfile

build: node_modules/.modules.yaml
	$(PNPM) build
	$(PNPM) ui:build

install: build
	rm -rf "$(DESTDIR)$(LIBDIR)"
	install -d "$(DESTDIR)$(LIBDIR)" "$(DESTDIR)$(BINDIR)"
	cp -a \
		LICENSE \
		README.md \
		assets \
		dist \
		docs \
		extensions \
		node_modules \
		openclaw.mjs \
		package.json \
		pnpm-lock.yaml \
		skills \
		"$(DESTDIR)$(LIBDIR)/"
	chmod 755 "$(DESTDIR)$(LIBDIR)/openclaw.mjs"
	ln -sfn "../lib/freeclaw/openclaw.mjs" "$(DESTDIR)$(BINDIR)/openclaw"
