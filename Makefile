PREFIX ?= /usr
LIBDIR ?= $(PREFIX)/lib/freeclaw
BINDIR ?= $(PREFIX)/bin
PNPM_VERSION ?= 11.5.2
PNPM ?= $(shell if command -v pnpm >/dev/null 2>&1; then command -v pnpm; elif command -v corepack >/dev/null 2>&1; then printf 'corepack pnpm'; else printf 'npx --yes pnpm@$(PNPM_VERSION)'; fi)

.PHONY: all build install ensure-pnpm prune-packaged-node-modules

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

prune-packaged-node-modules:
	@if [ -d "$(DESTDIR)$(LIBDIR)/node_modules/.pnpm" ]; then \
		pnpm_store="$(DESTDIR)$(LIBDIR)/node_modules/.pnpm"; \
		find "$$pnpm_store" -maxdepth 1 -type d \( \
			-name '*darwin*' -o \
			-name '*freebsd*' -o \
			-name '*openbsd*' -o \
			-name '*win32*' -o \
			-name '*linux-arm*' -o \
			-name '*linux-ia32*' -o \
			-name '*linux-loong*' -o \
			-name '*linux-riscv*' -o \
			-name '*musl*' \
		\) -prune -exec rm -rf {} +; \
		find "$$pnpm_store" -path '*/koffi/build/koffi/*/koffi.node' \
			! -path '*/koffi/build/koffi/linux_x64/koffi.node' \
			-delete; \
		find "$$pnpm_store" -path '*/prebuilds/*' -type d \
			! -name 'linux-x64' \
			! -name 'linux-x64-gnu' \
			-prune -exec rm -rf {} +; \
		find "$$pnpm_store" -maxdepth 1 -type d \( \
			-name 'oxlint*' -o \
			-name '@oxlint*' -o \
			-name 'oxfmt*' -o \
			-name '@oxfmt*' -o \
			-name 'oxlint-tsgolint*' -o \
			-name '@oxlint-tsgolint*' -o \
			-name 'esbuild@*' -o \
			-name '@esbuild+*' -o \
			-name 'rolldown@*' -o \
			-name '@rolldown+*' -o \
			-name 'tsdown@*' -o \
			-name 'lightningcss*' -o \
			-name '@typescript+native-preview*' -o \
			-name 'vitest@*' -o \
			-name '@vitest+*' -o \
			-name 'typescript@*' \
		\) -prune -exec rm -rf {} +; \
		find "$(DESTDIR)$(LIBDIR)/node_modules" -maxdepth 2 -xtype l -delete; \
		find "$(DESTDIR)$(LIBDIR)/node_modules" -mindepth 1 -maxdepth 2 -type d -empty -delete; \
	fi

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
		utils \
		"$(DESTDIR)$(LIBDIR)/"
	$(MAKE) DESTDIR="$(DESTDIR)" PREFIX="$(PREFIX)" prune-packaged-node-modules
	chmod 755 "$(DESTDIR)$(LIBDIR)/openclaw.mjs"
	ln -sfn "../lib/freeclaw/openclaw.mjs" "$(DESTDIR)$(BINDIR)/openclaw"
	set -e; for f in "$(DESTDIR)$(LIBDIR)"/utils/*.sh "$(DESTDIR)$(LIBDIR)"/utils/*.py; do \
		[ -f "$$f" ] || continue; \
		chmod 755 "$$f"; \
		base="$$(basename "$$f")"; \
		name="$$(printf '%s' "$${base%.*}" | tr '_' '-')"; \
		ln -sfn "../lib/freeclaw/utils/$$base" "$(DESTDIR)$(BINDIR)/$$name"; \
	done
