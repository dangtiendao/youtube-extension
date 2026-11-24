using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace TubeVaultTray
{
    internal sealed class RuntimeLock
    {
        public int Port { get; set; }
        public string Token { get; set; }
        public int Pid { get; set; }
    }

    internal sealed class TrayApplicationContext : ApplicationContext
    {
        private readonly NotifyIcon _trayIcon;
        private readonly ToolStripMenuItem _statusItem;
        private readonly string _nodeExe;
        private readonly string _engineCjs;
        private readonly string _appDataDir;
        private readonly string _lockPath;
        private readonly string _logPath;
        private readonly System.Windows.Forms.Timer _pollTimer;

        public TrayApplicationContext(string nodeExe, string engineCjs, bool openUiOnStart)
        {
            _nodeExe = nodeExe;
            _engineCjs = engineCjs;

            string envData = Environment.GetEnvironmentVariable("TUBEVAULT_DATA_DIR");
            _appDataDir = !string.IsNullOrEmpty(envData)
                ? envData
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TubeVault");
            _lockPath = Path.Combine(_appDataDir, "data", "runtime.json");
            _logPath = Path.Combine(_appDataDir, "logs", "engine.log");

            Icon appIcon = null;
            try
            {
                appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch { }

            _statusItem = new ToolStripMenuItem("Trang thai: Dang kiem tra...") { Enabled = false };

            var openUiItem = new ToolStripMenuItem("Mo TubeVault Web UI", null, (s, e) => OpenWebUi());
            openUiItem.Font = new Font(openUiItem.Font, FontStyle.Bold);

            var openDownloadsItem = new ToolStripMenuItem("Mo thu muc tai xuong", null, (s, e) => OpenDownloadsFolder());
            var openLogItem = new ToolStripMenuItem("Mo file Log chan doan", null, (s, e) => OpenLogFile());
            var restartItem = new ToolStripMenuItem("Khoi dong lai Engine", null, (s, e) => RestartEngine());
            var exitItem = new ToolStripMenuItem("Thoat hoan toan (Tat Engine)", null, (s, e) => ExitCompletely());

            var menu = new ContextMenuStrip();
            menu.Items.Add(_statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(openUiItem);
            menu.Items.Add(openDownloadsItem);
            menu.Items.Add(openLogItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(restartItem);
            menu.Items.Add(exitItem);

            _trayIcon = new NotifyIcon
            {
                Icon = appIcon ?? SystemIcons.Application,
                Text = "TubeVault — YouTube Downloader Engine",
                ContextMenuStrip = menu,
                Visible = true
            };
            _trayIcon.DoubleClick += (s, e) => OpenWebUi();

            EnsureEngineRunning();
            RefreshStatus();

            if (openUiOnStart)
            {
                OpenWebUi();
            }

            _pollTimer = new System.Windows.Forms.Timer { Interval = 5000 };
            _pollTimer.Tick += (s, e) => RefreshStatus();
            _pollTimer.Start();
        }

        private RuntimeLock ReadRuntimeLock()
        {
            try
            {
                if (!File.Exists(_lockPath)) return null;
                string raw = File.ReadAllText(_lockPath);
                Match portM = Regex.Match(raw, "\"port\"\\s*:\\s*(\\d+)");
                Match tokenM = Regex.Match(raw, "\"token\"\\s*:\\s*\"([^\"]+)\"");
                Match pidM = Regex.Match(raw, "\"pid\"\\s*:\\s*(\\d+)");
                if (!portM.Success || !tokenM.Success) return null;
                return new RuntimeLock
                {
                    Port = int.Parse(portM.Groups[1].Value),
                    Token = tokenM.Groups[1].Value,
                    Pid = pidM.Success ? int.Parse(pidM.Groups[1].Value) : 0
                };
            }
            catch
            {
                return null;
            }
        }

        private bool IsPortHealthy(int port)
        {
            if (port <= 0) return false;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/v1/health");
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

        private RuntimeLock EnsureEngineRunning()
        {
            RuntimeLock existing = ReadRuntimeLock();
            if (existing != null && IsPortHealthy(existing.Port))
            {
                return existing;
            }

            if (string.IsNullOrEmpty(_engineCjs) || !File.Exists(_engineCjs))
            {
                return null;
            }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = _nodeExe,
                    Arguments = "\"" + _engineCjs + "\" --server",
                    WorkingDirectory = Path.GetDirectoryName(_engineCjs) ?? AppDomain.CurrentDomain.BaseDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                Process.Start(psi);

                for (int i = 0; i < 40; i++)
                {
                    Thread.Sleep(200);
                    RuntimeLock fresh = ReadRuntimeLock();
                    if (fresh != null && IsPortHealthy(fresh.Port))
                    {
                        return fresh;
                    }
                }
            }
            catch { }

            return null;
        }

        private void RefreshStatus()
        {
            RuntimeLock info = ReadRuntimeLock();
            if (info != null && IsPortHealthy(info.Port))
            {
                _statusItem.Text = "Engine: Dang chay (127.0.0.1:" + info.Port + ")";
                _trayIcon.Text = "TubeVault — Dang chay (Port " + info.Port + ")";
            }
            else
            {
                _statusItem.Text = "Engine: Dang dung";
                _trayIcon.Text = "TubeVault — Engine dang dung";
            }
        }

        private void OpenWebUi()
        {
            RuntimeLock info = EnsureEngineRunning();
            int port = info != null ? info.Port : 17890;
            RefreshStatus();
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "http://127.0.0.1:" + port + "/",
                    UseShellExecute = true
                });
            }
            catch { }
        }

        private void OpenDownloadsFolder()
        {
            RuntimeLock info = ReadRuntimeLock();
            if (info != null && IsPortHealthy(info.Port))
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + info.Port + "/api/v1/fs/open-dir");
                    req.Method = "POST";
                    req.Timeout = 2000;
                    req.ContentType = "application/json";
                    req.Headers.Add("X-Auth-Token", info.Token);
                    using (var sw = new StreamWriter(req.GetRequestStream()))
                    {
                        sw.Write("{}");
                    }
                    using (req.GetResponse()) { }
                    return;
                }
                catch { }
            }

            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "TubeVault");
            Directory.CreateDirectory(fallback);
            Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "\"" + fallback + "\"", UseShellExecute = true });
        }

        private void OpenLogFile()
        {
            string logDir = Path.GetDirectoryName(_logPath);
            if (!string.IsNullOrEmpty(logDir)) Directory.CreateDirectory(logDir);
            if (File.Exists(_logPath))
            {
                Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "/select,\"" + _logPath + "\"", UseShellExecute = true });
            }
            else
            {
                Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = "\"" + logDir + "\"", UseShellExecute = true });
            }
        }

        private void ShutdownEngine()
        {
            RuntimeLock info = ReadRuntimeLock();
            if (info == null) return;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + info.Port + "/api/v1/system/shutdown");
                req.Method = "POST";
                req.Timeout = 2000;
                req.Headers.Add("X-Auth-Token", info.Token);
                using (req.GetResponse()) { }
            }
            catch
            {
                if (info.Pid > 0)
                {
                    try { Process.GetProcessById(info.Pid).Kill(); } catch { }
                }
            }
        }

        private void RestartEngine()
        {
            ShutdownEngine();
            Thread.Sleep(500);
            EnsureEngineRunning();
            RefreshStatus();
        }

        private void ExitCompletely()
        {
            _pollTimer.Stop();
            ShutdownEngine();
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            ExitThread();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string nodeExe = ResolveNodePath(exeDir);
            string engineCjs = ResolveEngineScript(exeDir);

            bool openUi = false;
            foreach (string arg in args)
            {
                if (string.Equals(arg, "--open-ui", StringComparison.OrdinalIgnoreCase))
                {
                    openUi = true;
                }
            }

            bool createdNew;
            using (var mutex = new Mutex(true, "Local\\TubeVaultTraySingleton", out createdNew))
            {
                if (!createdNew)
                {
                    // Tray already running — simply open Web UI using dynamic port from runtime.json
                    OpenExistingUi();
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApplicationContext(nodeExe, engineCjs, openUi));
            }
        }

        private static void OpenExistingUi()
        {
            int port = 17890;
            try
            {
                string envData = Environment.GetEnvironmentVariable("TUBEVAULT_DATA_DIR");
                string appData = !string.IsNullOrEmpty(envData)
                    ? envData
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TubeVault");
                string lockPath = Path.Combine(appData, "data", "runtime.json");
                if (File.Exists(lockPath))
                {
                    Match m = Regex.Match(File.ReadAllText(lockPath), "\"port\"\\s*:\\s*(\\d+)");
                    if (m.Success) port = int.Parse(m.Groups[1].Value);
                }
            }
            catch { }

            try
            {
                Process.Start(new ProcessStartInfo { FileName = "http://127.0.0.1:" + port + "/", UseShellExecute = true });
            }
            catch { }
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
