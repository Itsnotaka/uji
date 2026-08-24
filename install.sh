#!/bin/sh
# Install the uji CLI from GitHub Releases.
# Usage: curl -fsSL https://raw.githubusercontent.com/Itsnotaka/uji/main/install.sh | sh
set -eu

REPO="Itsnotaka/uji"

if ! command -v curl >/dev/null 2>&1; then
	echo "uji install: curl is required." >&2
	exit 1
fi

os=$(uname -s)
arch=$(uname -m)
case "$os" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*)
		echo "uji install: no prebuilt binary for ${os}. Only macOS and Linux have releases." >&2
		exit 1
		;;
esac
case "$arch" in
	arm64 | aarch64) arch=arm64 ;;
	x86_64) arch=x64 ;;
	*)
		echo "uji install: no prebuilt binary for ${arch}." >&2
		exit 1
		;;
esac

# releases/latest redirects to the newest tag. Reading the redirect skips the API
# and its rate limits.
final_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")
tag=${final_url##*/}
if [ -z "$tag" ]; then
	echo "uji install: could not find the latest release." >&2
	exit 1
fi

asset="uji-${tag}-${os}-${arch}"
base_url="https://github.com/${REPO}/releases/download/${tag}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset}.tar.gz ..."
curl -fsSL -o "${tmp}/${asset}.tar.gz" "${base_url}/${asset}.tar.gz"
curl -fsSL -o "${tmp}/${asset}.tar.gz.sha256" "${base_url}/${asset}.tar.gz.sha256"

cd "$tmp"
if command -v sha256sum >/dev/null 2>&1; then
	sha256sum -c "${asset}.tar.gz.sha256" >/dev/null
elif command -v shasum >/dev/null 2>&1; then
	shasum -a 256 -c "${asset}.tar.gz.sha256" >/dev/null
else
	echo "uji install: neither sha256sum nor shasum found, skipping verification." >&2
fi
echo "Checksum ok."

tar -xzf "${asset}.tar.gz"

install_dir="${UJI_INSTALL_DIR:-${HOME}/.local/bin}"
mkdir -p "$install_dir"
mv -f uji "${install_dir}/uji"

echo "Installed ${tag} to ${install_dir}/uji"

case ":${PATH}:" in
	*":${install_dir}:"*) ;;
	*)
		echo "Add it to your PATH, e.g.:"
		echo "  export PATH=\"${install_dir}:\$PATH\""
		;;
esac

echo "Then run: uji login"
