using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;

namespace TubeVaultLauncher
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string nodeExe = ResolveNodePath(exeDir);
            string engineCjs = ResolveEngineScript(exeDir);

            if (string.IsNullOrEmpty(nodeExe) || string.IsNullOrEmpty(engineCjs))
            {
                return 1;
            }

            bool openUi = false;
            foreach (string arg in args)
            {
                if (string.Equals(arg, "--open-ui", StringComparison.OrdinalIgnoreCase))
                {
                    openUi = true;
                }
            }

            if (openUi)
            {
                return LaunchServerAndOpenBrowser(nodeExe, engineCjs);
            }

            // Chrome Native Messaging Host bridge:
            // Spawn node.exe completely hidden (CreateNoWindow = true) and proxy raw binary stdin/stdout streams.
            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + engineCjs + "\" --native-host",
                WorkingDirectory = Path.GetDirectoryName(engineCjs) ?? exeDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            try
            {
                using (Process proc = Process.Start(psi))
                {
                    if (proc == null) return 1;

                    Stream hostIn = Console.OpenStandardInput();
                    Stream hostOut = Console.OpenStandardOutput();
                    Stream hostErr = Console.OpenStandardError();

                    Task inPump = PumpStreamAsync(hostIn, proc.StandardInput.BaseStream, closeDest: true);
                    Task outPump = PumpStreamAsync(proc.StandardOutput.BaseStream, hostOut, closeDest: false);
                    Task errPump = PumpStreamAsync(proc.StandardError.BaseStream, hostErr, closeDest: false);

                    proc.WaitForExit();
                    Task.WaitAll(new[] { outPump, errPump }, 3000);
                    return proc.ExitCode;
                }
            }
            catch
            {
                return 1;
            }
        }

        private static async Task PumpStreamAsync(Stream src, Stream dest, bool closeDest)
        {
            byte[] buf = new byte[16384];
            try
            {
                int read;
                while ((read = await src.ReadAsync(buf, 0, buf.Length).ConfigureAwait(false)) > 0)
                {
                    await dest.WriteAsync(buf, 0, read).ConfigureAwait(false);
                    await dest.FlushAsync().ConfigureAwait(false);
                }
            }
            catch
            {
                // Stream closed
            }
            finally
            {
                if (closeDest)
                {
                    try { dest.Close(); } catch { }
                }
            }
        }

        private static int LaunchServerAndOpenBrowser(string nodeExe, string engineCjs)
        {
            const string healthUrl = "http://127.0.0.1:17890/api/v1/health";
            const string webUrl = "http://127.0.0.1:17890/";

            if (!IsHealthy(healthUrl))
            {
                var psi = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    Arguments = "\"" + engineCjs + "\" --server",
                    WorkingDirectory = Path.GetDirectoryName(engineCjs) ?? AppDomain.CurrentDomain.BaseDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                Process.Start(psi);

                for (int i = 0; i < 40; i++)
                {
                    Thread.Sleep(200);
                    if (IsHealthy(healthUrl)) break;
                }
            }

            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = webUrl,
                    UseShellExecute = true
                });
            }
            catch
            {
                return 1;
            }
            return 0;
        }

        private static bool IsHealthy(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 1000;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static string ResolveNodePath(string exeDir)
        {
            string[] candidates =
            {
                Path.GetFullPath(Path.Combine(exeDir, "..", "runtime", "node.exe")),
                Path.GetFullPath(Path.Combine(exeDir, "runtime", "node.exe")),
                Path.GetFullPath(Path.Combine(exeDir, "node.exe"))
            };
            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return "node.exe";
        }

        private static string ResolveEngineScript(string exeDir)
        {
            string[] candidates =
            {
                Path.GetFullPath(Path.Combine(exeDir, "engine.cjs")),
                Path.GetFullPath(Path.Combine(exeDir, "..", "app", "engine.cjs")),
                Path.GetFullPath(Path.Combine(exeDir, "..", "..", "packages", "engine", "dist", "engine.cjs"))
            };
            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return string.Empty;
        }
    }
}
