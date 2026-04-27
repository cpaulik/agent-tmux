APP_NAME    := Claude Issue Tracker
INSTALL_DIR := $(HOME)/Applications
APP_PATH    := $(INSTALL_DIR)/$(APP_NAME).app
BUILD_DIR   := $(CURDIR)/.build
ELECTRON_DIR := $(CURDIR)/electron

.PHONY: app app-clean help

help:
	@echo "Targets:"
	@echo "  app        build and install the Electron .app to $(INSTALL_DIR)"
	@echo "  app-clean  remove the installed .app"
	@echo ""
	@echo "Vars (override on the command line):"
	@echo "  APP_NAME=\"$(APP_NAME)\""
	@echo "  INSTALL_DIR=$(INSTALL_DIR)"
	@echo "  ICON=path/to/icon.{png,icns}   (optional)"

app:
	@command -v npx >/dev/null || { echo "npx not found — install Node.js first"; exit 1; }
	cd "$(ELECTRON_DIR)" && npm install
	@echo '{"serverDir":"$(CURDIR)"}' > "$(ELECTRON_DIR)/config.json"
	@rm -rf "$(BUILD_DIR)"
	npx --yes electron-packager "$(ELECTRON_DIR)" "$(APP_NAME)" \
	    --platform=darwin --arch=arm64 \
	    --out="$(BUILD_DIR)" --overwrite \
	    --darwin-dark-mode-support \
	    $(if $(ICON),--icon "$(ICON)",)
	@rm -f "$(ELECTRON_DIR)/config.json"
	@built="$$(find "$(BUILD_DIR)" -maxdepth 2 -name '*.app' -type d | head -n1)"; \
	 test -n "$$built" || { echo "build produced no .app"; exit 1; }; \
	 rm -rf "$(APP_PATH)"; \
	 mkdir -p "$(INSTALL_DIR)"; \
	 mv "$$built" "$(APP_PATH)"
	@rm -rf "$(BUILD_DIR)"
	@echo "installed: $(APP_PATH)"

app-clean:
	@rm -rf "$(APP_PATH)" "$(BUILD_DIR)"
	@echo "removed: $(APP_PATH)"
