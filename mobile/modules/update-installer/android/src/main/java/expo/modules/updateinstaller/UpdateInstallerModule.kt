package expo.modules.updateinstaller

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class UpdateInstallerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("UpdateInstaller")

    AsyncFunction("download") { url: String, expectedBytes: Double, expectedSha256: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android application context is unavailable.")
      val byteCount = expectedBytes.toLong()
      require(byteCount in 1..MAX_APK_BYTES) { "Android APK size is outside the supported range." }
      require(expectedSha256.matches(Regex("^[a-fA-F0-9]{64}$"))) { "Android APK checksum is invalid." }

      val updateDirectory = File(context.cacheDir, "updates").apply { mkdirs() }
      val temporaryFile = File(updateDirectory, "rhzycode-update.apk.download")
      val apkFile = File(updateDirectory, APK_FILE_NAME)
      temporaryFile.delete()

      val digest = MessageDigest.getInstance("SHA-256")
      val connection = URL(url).openConnection() as HttpURLConnection
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      connection.instanceFollowRedirects = true
      connection.setRequestProperty("Accept", "application/vnd.android.package-archive")

      try {
        connection.connect()
        if (connection.responseCode !in 200..299) {
          throw IllegalStateException("Update service returned HTTP ${connection.responseCode}.")
        }
        val responseLength = connection.contentLengthLong
        if (responseLength > 0 && responseLength != byteCount) {
          throw IllegalStateException("Downloaded APK size does not match the update manifest.")
        }

        var downloaded = 0L
        connection.inputStream.buffered().use { input ->
          temporaryFile.outputStream().buffered().use { output ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              downloaded += read
              if (downloaded > byteCount) {
                throw IllegalStateException("Downloaded APK is larger than the update manifest.")
              }
              digest.update(buffer, 0, read)
              output.write(buffer, 0, read)
            }
          }
        }

        if (downloaded != byteCount) {
          throw IllegalStateException("Downloaded APK size does not match the update manifest.")
        }
        val actualSha256 = digest.digest().joinToString("") { byte ->
          "%02x".format(byte.toInt() and 0xff)
        }
        if (!actualSha256.equals(expectedSha256, ignoreCase = true)) {
          throw IllegalStateException("Downloaded APK checksum verification failed.")
        }

        apkFile.delete()
        if (!temporaryFile.renameTo(apkFile)) {
          throw IllegalStateException("Downloaded APK could not be finalized.")
        }
        mapOf("bytes" to downloaded.toDouble(), "sha256" to actualSha256)
      } catch (error: Throwable) {
        temporaryFile.delete()
        throw error
      } finally {
        connection.disconnect()
      }
    }

    AsyncFunction("canInstallPackages") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android application context is unavailable.")
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    }

    AsyncFunction("requestInstallPermission") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android application context is unavailable.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}")
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
      }
    }

    AsyncFunction("installDownloaded") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android application context is unavailable.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
        throw IllegalStateException("Android package installation permission has not been granted.")
      }
      val apkFile = File(File(context.cacheDir, "updates"), APK_FILE_NAME)
      if (!apkFile.isFile) throw IllegalStateException("Downloaded APK is unavailable.")
      val contentUri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.FileSystemFileProvider",
        apkFile
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      context.startActivity(intent)
    }
  }

  private companion object {
    const val APK_FILE_NAME = "rhzycode-update.apk"
    const val MAX_APK_BYTES = 512L * 1024L * 1024L
  }
}
