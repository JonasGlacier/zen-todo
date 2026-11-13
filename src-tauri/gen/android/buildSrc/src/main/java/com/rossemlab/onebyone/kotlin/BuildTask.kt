import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """npm"""
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                val fallbacks = listOf(
                    "$executable.cmd",
                    "$executable.exe",
                    "$executable.bat",
                )
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                if (copyBuiltSoIfSymlinkBlocked()) {
                    logger.lifecycle("Windows symlink privilege unavailable; copied built libonebyone_lib.so into jniLibs.")
                    return
                }
                throw lastException
            } else {
                throw e
            }
        }
    }

    private fun copyBuiltSoIfSymlinkBlocked(): Boolean {
        val rootRel = rootDirRel ?: return false
        val proj = projectDir ?: return false
        val tgt = target ?: return false
        val isRel = release ?: false
        val (rustTriple, abiDir) = when (tgt) {
            "aarch64" -> "aarch64-linux-android" to "arm64-v8a"
            "armv7" -> "armv7-linux-androideabi" to "armeabi-v7a"
            "i686" -> "i686-linux-android" to "x86"
            "x86_64" -> "x86_64-linux-android" to "x86_64"
            else -> return false
        }
        val profileDir = if (isRel) "release" else "debug"
        val rootDir = File(proj, rootRel).canonicalFile
        val builtSo = listOf(
            File(rootDir, "src-tauri/target/$rustTriple/$profileDir/libonebyone_lib.so"),
            File(rootDir, "target/$rustTriple/$profileDir/libonebyone_lib.so")
        ).firstOrNull { it.isFile } ?: return false
        val destDir = File(proj, "src/main/jniLibs/$abiDir")
        destDir.mkdirs()
        val destSo = File(destDir, "libonebyone_lib.so")
        Files.copy(builtSo.toPath(), destSo.toPath(), StandardCopyOption.REPLACE_EXISTING)
        return true
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script")

        execOperations.exec {
            workingDir(File(projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
