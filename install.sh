#!/bin/sh
# Install the uji CLI from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Itsnotaka/uji/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/Itsnotaka/uji/main/install.sh | sh -s -- --version 0.2.0
#   curl -fsSL https://raw.githubusercontent.com/Itsnotaka/uji/main/install.sh | sh -s -- --no-modify-path
#
# Environment:
#   UJI_INSTALL_DIR     where the binary goes (default ~/.local/bin)
#   UJI_VERSION         release to install (default: latest)
#   UJI_NO_MODIFY_PATH  set to skip editing the shell rc file
#
# The PATH handling (pick the rc file from $SHELL, append one exact line only
# when it is missing, never rewrite the file) is based on
# https://github.com/anomalyco/opencode/blob/v2/install
set -eu

REPO="Itsnotaka/uji"

usage() {
	cat <<EOF
uji installer

Usage: install.sh [options]

Options:
  -h, --help              Show this help
  -v, --version <version> Install a specific release (e.g. 0.2.0)
      --no-modify-path    Don't edit shell rc files (.zshrc, .bashrc, config.fish)
EOF
}

requested_version="${UJI_VERSION:-}"
no_modify_path="${UJI_NO_MODIFY_PATH:-}"

while [ $# -gt 0 ]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		-v | --version)
			if [ -z "${2:-}" ]; then
				echo "uji install: --version needs a version argument." >&2
				exit 1
			fi
			requested_version="$2"
			shift 2
			;;
		--no-modify-path)
			no_modify_path=1
			shift
			;;
		*)
			echo "uji install: unknown option '$1'." >&2
			usage >&2
			exit 1
			;;
	esac
done

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

if [ -n "$requested_version" ]; then
	tag="v${requested_version#v}"
	status=$(curl -fsSLI -o /dev/null -w '%{http_code}' "https://github.com/${REPO}/releases/tag/${tag}" || true)
	if [ "$status" = "404" ]; then
		echo "uji install: release ${tag} not found. See https://github.com/${REPO}/releases" >&2
		exit 1
	fi
else
	# releases/latest redirects to the newest tag. Reading the redirect skips the API
	# and its rate limits.
	final_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")
	tag=${final_url##*/}
	if [ -z "$tag" ] || [ "$tag" = "latest" ]; then
		echo "uji install: could not find the latest release." >&2
		exit 1
	fi
fi

asset="uji-${tag}-${os}-${arch}"
base_url="https://github.com/${REPO}/releases/download/${tag}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset}.tar.gz …"
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
chmod 755 "${install_dir}/uji"

echo "Installed uji ${tag#v} to ${install_dir}/uji"

# Append `command` to `file` once. The exact line already present means skip;
# an unwritable file means print the line for the user instead.
add_to_path() {
	file=$1
	command=$2
	if grep -Fxq "$command" "$file" 2>/dev/null; then
		echo "PATH already set in ${file}."
	elif [ -w "$file" ]; then
		printf '\n# uji\n%s\n' "$command" >>"$file"
		echo "Added ${install_dir} to PATH in ${file}."
		echo "Open a new terminal, or run: ${command}"
	else
		echo "Can't write ${file}. Add this line to it yourself:" >&2
		echo "  ${command}" >&2
	fi
}

modify_path() {
	xdg_config="${XDG_CONFIG_HOME:-${HOME}/.config}"
	shell_name=$(basename "${SHELL:-sh}")
	case "$shell_name" in
		fish)
			rc_files="${HOME}/.config/fish/config.fish"
			line="fish_add_path ${install_dir}"
			;;
		zsh)
			rc_files="${ZDOTDIR:-${HOME}}/.zshrc ${ZDOTDIR:-${HOME}}/.zshenv ${xdg_config}/zsh/.zshrc ${xdg_config}/zsh/.zshenv"
			line="export PATH=\"${install_dir}:\$PATH\""
			;;
		bash)
			rc_files="${HOME}/.bashrc ${HOME}/.bash_profile ${HOME}/.profile ${xdg_config}/bash/.bashrc ${xdg_config}/bash/.bash_profile"
			line="export PATH=\"${install_dir}:\$PATH\""
			;;
		ash | sh)
			rc_files="${HOME}/.ashrc ${HOME}/.profile /etc/profile"
			line="export PATH=\"${install_dir}:\$PATH\""
			;;
		*)
			rc_files="${HOME}/.bashrc ${HOME}/.bash_profile ${HOME}/.profile"
			line="export PATH=\"${install_dir}:\$PATH\""
			;;
	esac

	rc_file=""
	for candidate in $rc_files; do
		if [ -f "$candidate" ]; then
			rc_file=$candidate
			break
		fi
	done

	if [ -z "$rc_file" ]; then
		echo "No ${shell_name} rc file found. Add ${install_dir} to PATH yourself:" >&2
		echo "  ${line}" >&2
		return
	fi
	add_to_path "$rc_file" "$line"
}

case ":${PATH}:" in
	*":${install_dir}:"*) ;;
	*)
		if [ -n "$no_modify_path" ]; then
			echo "Add ${install_dir} to PATH:"
			echo "  export PATH=\"${install_dir}:\$PATH\""
		else
			modify_path
		fi
		;;
esac

if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "${GITHUB_PATH:-}" ]; then
	echo "$install_dir" >>"$GITHUB_PATH"
	echo "Added ${install_dir} to GITHUB_PATH."
fi

echo "Next: uji login"
