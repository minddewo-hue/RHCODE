const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withPrivateNetworkCleartext(config) {
  return withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ || {};
      application.$["android:usesCleartextTraffic"] = "true";
    }
    return result;
  });
};
