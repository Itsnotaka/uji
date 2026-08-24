#!/bin/sh
# Build bin/uji from packages/tui and stage release artifacts in dist/.
# Produces dist/<name>/<name>.tar.gz plus a .sha256 beside it, where
# <name> is uji-v<version>-<os>-<arch>.
#
# Upload the pair with:
#   gh release create vX.Y.Z --target main dist/*.tar.gz dist/*.sha256
set -eu
cd "$(dirname "$0")/.."

version=$(node -p "require('./packages/tui/package.json').version")

platform="$(uname -s)-$(uname -m)"
case "$platform" in
	Darwin-arm64) target=darwin-arm64 ;;
	Darwin-x86_64) target=darwin-x64 ;;
	Linux-x86_64) target=linux-x64 ;;
	Linux-aarch64) target=linux-arm64 ;;
	*)
		echo "No packaging target for ${platform}." >&2
		exit 1
		;;
esac

name="uji-v${version}-${target}"

pnpm build:cli

rm -rf "dist/${name}"
mkdir -p "dist/${name}"
cp bin/uji "dist/${name}/uji"

# COPYFILE_DISABLE keeps macOS tar from adding AppleDouble ._ entries.
COPYFILE_DISABLE=1 tar -czf "dist/${name}.tar.gz" -C "dist/${name}" uji
(cd dist && shasum -a 256 "${name}.tar.gz" >"${name}.tar.gz.sha256")

echo "Staged:"
ls -la "dist/${name}.tar.gz" "dist/${name}.tar.gz.sha256"
