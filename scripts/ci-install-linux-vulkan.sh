#!/bin/bash
# Packages for a whisper.cpp v1.9.5 Vulkan build on Ubuntu 22.04.
# CMake 3.22 cannot find Vulkan's glslc component (that landed in 3.24).
# glslc and the Vulkan headers come from the pinned LunarG SDK. The workflow
# exports VULKAN_SDK=/opt/vulkan-sdk so CMake does not use Ubuntu 22.04's
# libvulkan-dev headers. The finished engine is patched to RUNPATH $ORIGIN
# and is not shipped with the SDK's libvulkan; at runtime it loads the
# system libvulkan.so.1.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl git g++-12 gcc-12 \
  libgomp1 libvulkan-dev patchelf pkg-config python3 xz-utils

if ! /opt/cmake/bin/cmake --version >/dev/null 2>&1; then
  curl -fsSL -o /tmp/cmake.tgz https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-linux-x86_64.tar.gz
  mkdir -p /opt/cmake
  tar -xzf /tmp/cmake.tgz -C /opt/cmake --strip-components=1
fi

# Ubuntu 22.04's libvulkan-dev headers are too old for whisper.cpp v1.9.5
# (missing LayerSettingEXT and DriverId::eMesaDozen). Compile against the
# pinned SDK headers. The finished engine is patched to RUNPATH $ORIGIN and
# is not shipped with the SDK's libvulkan; at runtime it loads the system loader.
if [ ! -x /opt/vulkan-sdk/bin/glslc ]; then
  curl -fsSL -o /tmp/vulkansdk.tar.xz https://sdk.lunarg.com/sdk/download/1.3.296.0/linux/vulkansdk-linux-x86_64-1.3.296.0.tar.xz
  rm -rf /tmp/vulkansdk
  mkdir -p /tmp/vulkansdk
  tar -xJf /tmp/vulkansdk.tar.xz -C /tmp/vulkansdk
  sdk_root="$(find /tmp/vulkansdk -type f -name glslc -perm -111 | head -1)"
  [ -n "$sdk_root" ] || { echo "glslc not in the Vulkan SDK archive" >&2; exit 1; }
  sdk_root="$(cd "$(dirname "$sdk_root")/.." && pwd)"
  rm -rf /opt/vulkan-sdk
  mkdir -p /opt/vulkan-sdk
  cp -a "$sdk_root/bin" "$sdk_root/lib" "$sdk_root/include" /opt/vulkan-sdk/
fi
cat > /usr/local/bin/glslc <<'EOF'
#!/bin/sh
export LD_LIBRARY_PATH="/opt/vulkan-sdk/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec /opt/vulkan-sdk/bin/glslc "$@"
EOF
chmod 755 /usr/local/bin/glslc

if ! find /usr /opt/cmake -name 'SPIRV-HeadersConfig.cmake' 2>/dev/null | grep -q .; then
  rm -rf /tmp/SPIRV-Headers
  git clone --depth 1 --branch vulkan-sdk-1.3.296.0 https://github.com/KhronosGroup/SPIRV-Headers.git /tmp/SPIRV-Headers
  /opt/cmake/bin/cmake -S /tmp/SPIRV-Headers -B /tmp/SPIRV-Headers/build -DCMAKE_INSTALL_PREFIX=/usr/local
  /opt/cmake/bin/cmake --install /tmp/SPIRV-Headers/build
fi

glslc --version
/opt/cmake/bin/cmake --version
echo "linux vulkan build dependencies ready"
