using System;
using System.Diagnostics;
using System.Threading;
using System.IO;

// Chrome launches this small executable; no console window and no shell parsing.
class Launcher {
  static void Pump(Stream source, Stream destination) {
    byte[] buffer = new byte[8192];
    int count;
    while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
      destination.Write(buffer, 0, count);
      destination.Flush();
    }
  }
  static int Main(string[] args) {
    if (args.Length == 0 || !System.Text.RegularExpressions.Regex.IsMatch(args[0], @"^chrome-extension://[a-p]{32}/$")) return 1;
    var info = new ProcessStartInfo();
    info.FileName = @@NODE@@;
    info.Arguments = "\"" + @@HOST@@ + "\" " + args[0];
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.RedirectStandardInput = true;
    info.RedirectStandardOutput = true;
    info.RedirectStandardError = true;
    info.EnvironmentVariables["BOOKMARK_AGENT_HOME"] = @@CONFIG@@;
    using (var child = Process.Start(info)) {
      var input = new Thread(() => {
        try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
        catch { }
        finally { try { child.StandardInput.Close(); } catch { } }
      });
      var errors = new Thread(() => { try { Pump(child.StandardError.BaseStream, Console.OpenStandardError()); } catch { } });
      input.IsBackground = true; errors.IsBackground = true;
      input.Start(); errors.Start();
      try { Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); }
      catch { try { child.Kill(); } catch { } }
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
