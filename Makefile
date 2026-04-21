APP_NAME  := Claude Issue Tracker
APP_URL   := http://127.0.0.1:8765
INSTALL_DIR := $(HOME)/Applications
APP_PATH  := $(INSTALL_DIR)/$(APP_NAME).app
BUILD_DIR := $(CURDIR)/.build

.PHONY: app app-clean help

help:
	@echo "Targets:"
	@echo "  app        build and install the native .app (via nativefier) to $(INSTALL_DIR)"
	@echo "  app-clean  remove the installed .app"
	@echo ""
	@echo "Vars (override on the command line):"
	@echo "  APP_NAME=\"$(APP_NAME)\""
	@echo "  APP_URL=$(APP_URL)"
	@echo "  INSTALL_DIR=$(INSTALL_DIR)"
	@echo "  ICON=path/to/icon.{png,icns}   (optional)"

app:
	@command -v npx >/dev/null || { echo "npx not found — install Node.js first"; exit 1; }
	@rm -rf "$(BUILD_DIR)"
	@mkdir -p "$(BUILD_DIR)"
	npx --yes nativefier@latest \
	    --name "$(APP_NAME)" \
	    --internal-urls ".*" \
	    --single-instance \
	    --darwin-dark-mode-support \
	    $(if $(ICON),--icon "$(ICON)",) \
	    "$(APP_URL)" "$(BUILD_DIR)"
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
