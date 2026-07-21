const fs = require("node:fs");
const path = require("node:path");
const { withAppBuildGradle, withDangerousMod, withGradleProperties } = require("@expo/config-plugins");

const defaultWindowsJdk = "C:/Program Files/Android/Android Studio/jbr";
const defaultWindowsSdk = "D:/android_sdk";

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function resolveToolchain() {
  const javaHome = firstExisting([
    process.env.RHZYCODE_GRADLE_JAVA_HOME,
    process.platform === "win32" ? defaultWindowsJdk : undefined,
    process.env.JAVA_HOME,
  ]);
  const sdkHome = firstExisting([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" ? defaultWindowsSdk : undefined,
  ]);
  return { javaHome, sdkHome };
}

function escapeJavaPropertyPath(value) {
  return value.replace(/\\/g, "\\\\").replace(/^([A-Za-z]):/, "$1\\:");
}

module.exports = function withAndroidLocalToolchain(config) {
  const toolchain = resolveToolchain();

  if (toolchain.javaHome) {
    config = withGradleProperties(config, (result) => {
      const key = "org.gradle.java.home";
      const existing = result.modResults.find(
        (item) => item.type === "property" && item.key === key,
      );
      if (existing) existing.value = toolchain.javaHome.replace(/\\/g, "/");
      else result.modResults.push({ type: "property", key, value: toolchain.javaHome.replace(/\\/g, "/") });
      return result;
    });
  }

  config = withAppBuildGradle(config, (result) => {
    const defaultVariants = '    // debuggableVariants = ["liteDebug", "prodDebug"]';
    if (result.modResults.contents.includes(defaultVariants)) {
      result.modResults.contents = result.modResults.contents.replace(
        defaultVariants,
        "    // Keep Android Studio builds usable before a desktop connection or Metro is configured.\n    debuggableVariants = []",
      );
    }
    return result;
  });

  return withDangerousMod(config, ["android", async (result) => {
    const androidRoot = result.modRequest.platformProjectRoot;
    if (toolchain.javaHome) {
      const gradleConfigDirectory = path.join(androidRoot, ".gradle");
      fs.mkdirSync(gradleConfigDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(gradleConfigDirectory, "config.properties"),
        `java.home=${escapeJavaPropertyPath(toolchain.javaHome)}\n`,
      );
    }
    if (toolchain.sdkHome) {
      fs.writeFileSync(
        path.join(androidRoot, "local.properties"),
        `sdk.dir=${escapeJavaPropertyPath(toolchain.sdkHome)}\n`,
      );
    }
    return result;
  }]);
};
