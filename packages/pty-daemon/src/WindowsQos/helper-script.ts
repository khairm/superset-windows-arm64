/**
 * (WIN-TERMINAL-HIGHQOS) The QoS helper: Windows PowerShell 5.1 compiles this
 * C# with Add-Type and runs it for the life of ptyd. C# 5 only (the
 * .NET Framework compiler); no backslash or backtick in the text, and
 * dollar-brace only to insert this file's constants.
 */

export const QOS_HELPER_CS_ENV = "SUPERSET_QOS_CS";
export const QOS_HELPER_PTYD_ENV = "SUPERSET_QOS_PTYD";

export const QOS_HELPER_COMMAND = `$ErrorActionPreference='Stop'; $t=[Diagnostics.Stopwatch]::StartNew(); Add-Type -TypeDefinition $env:${QOS_HELPER_CS_ENV}; exit ([Superset.Qos]::Run($t.ElapsedMilliseconds))`;

export const QOS_HELPER_LINE_KEYS = {
	ready: ["arch", "compileMs", "ptydTagged"],
	stats: [
		"tagged",
		"raced",
		"recycled",
		"unreachable",
		"unknown",
		"errors",
		"procs",
		"tickMs",
		"cpuMs",
	],
	error: ["op", "code", "count"],
} as const;

export const QOS_HELPER_MAX_LINE_BYTES = 256;

export const QOS_HELPER_CS = `using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Superset
{
    public static class Qos
    {
        const uint SetInformation = 0x200, QueryLimited = 0x1000, Synchronize = 0x100000, ExecutionSpeed = 1;
        const int PowerThrottling = 4, ThrottleSize = 12, StillActive = 259, AccessDenied = 5, Gone = 87;
        const int ProcessList = 5, LengthMismatch = unchecked((int)0xC0000004), MaxListBytes = 64 << 20;
        const int TickMs = 1000, WindowMs = 60000, MaxLine = ${QOS_HELPER_MAX_LINE_BYTES - 1};

        sealed class Handle : SafeHandleZeroOrMinusOneIsInvalid
        {
            public Handle() : base(true) { }
            protected override bool ReleaseHandle() { return CloseHandle(handle); }
        }

        sealed class ProcessWait : WaitHandle
        {
            public ProcessWait(SafeWaitHandle h) { SafeWaitHandle = h; }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct Throttle { public uint Version, ControlMask, StateMask; }

        struct Proc
        {
            public uint Parent;
            public long Ctime;
        }

        struct Node
        {
            public uint Pid;
            public long Ctime;
            public Node(uint pid, long ctime) { Pid = pid; Ctime = ctime; }
        }

        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern Handle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", EntryPoint = "OpenProcess", SetLastError = true)] static extern SafeWaitHandle OpenProcessWait(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(SafeHandle h, out long create, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(SafeHandle h, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessInformation(SafeHandle h, int cls, ref Throttle info, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(SafeHandle h, int cls, ref Throttle info, int size);
        [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, [Out] byte[] buffer, int length, out int needed);
        [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();

        static uint ptydPid, selfPid;
        static long ptydCtime;
        static Handle self;
        static int lastError, tagged, raced, recycled, unreachable, unknown, errors, procs;
        static byte[] buffer = new byte[1 << 20];
        static readonly Dictionary<uint, Proc> table = new Dictionary<uint, Proc>();
        static readonly Dictionary<uint, long> members = new Dictionary<uint, long>();
        static readonly Dictionary<uint, long> unreachableSeen = new Dictionary<uint, long>();
        static readonly Dictionary<string, int> windowErrors = new Dictionary<string, int>();
        static readonly List<double> tickTimes = new List<double>();
        static Dictionary<uint, bool> visited;
        static Queue<Node> queue;

        public static int Run(long compileMs)
        {
            if (IntPtr.Size != 8) return Refuse("snapshot", IntPtr.Size, compileMs);
            selfPid = GetCurrentProcessId();
            self = OpenProcess(SetInformation | QueryLimited, false, selfPid);
            if (self.IsInvalid) return Refuse("self-open", Marshal.GetLastWin32Error(), compileMs);
            if (!uint.TryParse(Environment.GetEnvironmentVariable("${QOS_HELPER_PTYD_ENV}"), out ptydPid) || ptydPid == 0) return Refuse("ptyd-env", 13, compileMs);
            SafeWaitHandle ptyd = OpenProcessWait(Synchronize | QueryLimited | SetInformation, false, ptydPid);
            if (ptyd.IsInvalid) return Refuse("ptyd-open", Marshal.GetLastWin32Error(), compileMs);
            using (var ptydWait = new ProcessWait(ptyd))
            {
                int failedCheck = Verify(ptyd, ptydWait);
                if (failedCheck != 0) return Refuse("ptyd-verify", failedCheck, compileMs);
                bool changed;
                string failed = Raise(ptyd, true, out changed);
                if (failed != null) EmitError("ptyd-" + failed, lastError);
                bool ptydTagged = failed == null;
                failed = Raise(self, false, out changed);
                if (failed != null) EmitError("self-" + failed, lastError);
                Emit(Ready(compileMs, ptydTagged));

                var eof = new ManualResetEvent(false);
                var reader = new Thread(() => { while (Console.In.ReadLine() != null) { } eof.Set(); });
                reader.IsBackground = true;
                reader.Start();
                var waits = new WaitHandle[] { ptydWait, eof };
                var clock = Stopwatch.StartNew();
                long next = 0, windowStart = 0, cpuStart = CpuMs();
                while (true)
                {
                    if (Exited(ptyd)) return 0;
                    Tick();
                    if (clock.ElapsedMilliseconds - windowStart >= WindowMs)
                    {
                        long cpu = CpuMs();
                        Report(cpu - cpuStart);
                        cpuStart = cpu;
                        windowStart = clock.ElapsedMilliseconds;
                    }
                    next += TickMs;
                    long delay = next - clock.ElapsedMilliseconds;
                    if (delay < 0) { next = clock.ElapsedMilliseconds; delay = 0; }
                    if (WaitHandle.WaitAny(waits, (int)delay) != WaitHandle.WaitTimeout) return 0;
                }
            }
        }

        static int Verify(SafeWaitHandle ptyd, WaitHandle ptydWait)
        {
            if (ptydWait.WaitOne(0)) return 1;
            long selfCtime;
            if (!Ctime(ptyd, out ptydCtime) || !Ctime(self, out selfCtime) || ptydCtime >= selfCtime) return 2;
            Proc me;
            if (!Snapshot() || !table.TryGetValue(selfPid, out me) || me.Parent != ptydPid) return 3;
            return 0;
        }

        static int Refuse(string op, int code, long compileMs)
        {
            foreach (var e in windowErrors) Emit("error " + e.Key + " count=" + e.Value);
            EmitError(op, code);
            Emit(Ready(compileMs, false));
            return 2;
        }

        static string Ready(long compileMs, bool ptydTagged)
        {
            string arch = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE");
            if (arch == null || !Regex.IsMatch(arch, "^[A-Za-z0-9_]{1,16}$")) arch = "invalid";
            return "ready arch=" + arch + " compileMs=" + compileMs + " ptydTagged=" + (ptydTagged ? 1 : 0);
        }

        static void Tick()
        {
            var clock = Stopwatch.StartNew();
            if (Snapshot()) Walk();
            tickTimes.Add(clock.Elapsed.TotalMilliseconds);
        }

        static bool Snapshot()
        {
            table.Clear();
            int needed, status;
            while ((status = NtQuerySystemInformation(ProcessList, buffer, buffer.Length, out needed)) == LengthMismatch && buffer.Length < MaxListBytes)
                buffer = new byte[Math.Min(MaxListBytes, Math.Max(buffer.Length * 2, needed))];
            if (status != 0) { Error("snapshot", (uint)status); return false; }
            for (int at = 0; ; )
            {
                var p = new Proc();
                p.Ctime = BitConverter.ToInt64(buffer, at + 0x20);
                p.Parent = (uint)BitConverter.ToInt64(buffer, at + 0x58);
                table[(uint)BitConverter.ToInt64(buffer, at + 0x50)] = p;
                int next = BitConverter.ToInt32(buffer, at);
                if (next == 0) return true;
                at += next;
            }
        }

        static void Walk()
        {
            procs = table.Count;
            var kids = new Dictionary<uint, List<uint>>();
            foreach (var p in table)
            {
                if (p.Key == p.Value.Parent) continue;
                List<uint> list;
                if (!kids.TryGetValue(p.Value.Parent, out list)) { list = new List<uint>(); kids[p.Value.Parent] = list; }
                list.Add(p.Key);
            }
            visited = new Dictionary<uint, bool>();
            queue = new Queue<Node>();
            visited[ptydPid] = true;
            queue.Enqueue(new Node(ptydPid, ptydCtime));
            var dead = new Dictionary<uint, bool>();
            foreach (var m in new List<KeyValuePair<uint, long>>(members))
            {
                Proc p;
                if (!table.TryGetValue(m.Key, out p)) { dead[m.Key] = false; queue.Enqueue(new Node(m.Key, m.Value)); }
                else if (p.Ctime != m.Value) { recycled++; members.Remove(m.Key); }
                else { visited[m.Key] = true; Visit(m.Key, m.Value, true); }
            }
            while (queue.Count > 0)
            {
                Node n = queue.Dequeue();
                List<uint> list;
                if (!kids.TryGetValue(n.Pid, out list)) continue;
                bool parentDead = dead.ContainsKey(n.Pid);
                foreach (uint pid in list)
                {
                    bool valid;
                    long seen;
                    if (visited.ContainsKey(pid)) valid = members.TryGetValue(pid, out seen) && seen >= n.Ctime;
                    else { visited[pid] = true; valid = Visit(pid, n.Ctime, false); }
                    if (valid && parentDead) dead[n.Pid] = true;
                }
            }
            foreach (var d in dead) if (!d.Value) members.Remove(d.Key);
            foreach (uint pid in new List<uint>(unreachableSeen.Keys)) if (!table.ContainsKey(pid)) unreachableSeen.Remove(pid);
        }

        static bool Visit(uint pid, long bound, bool member)
        {
            long ctime = table[pid].Ctime;
            if (ctime < bound) { recycled++; return false; }
            using (var h = OpenProcess(QueryLimited, false, pid))
            {
                if (h.IsInvalid)
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code == Gone) raced++; else if (code == AccessDenied) unknown++; else Error("open", code);
                    return false;
                }
                long opened;
                if (!Ctime(h, out opened)) return false;
                if (opened != ctime)
                {
                    recycled++;
                    if (member) members.Remove(pid);
                    return false;
                }
                members[pid] = ctime;
                queue.Enqueue(new Node(pid, ctime));
                if (Exited(h)) { raced++; return true; }
                var t = new Throttle();
                t.Version = 1;
                if (!GetProcessInformation(h, PowerThrottling, ref t, ThrottleSize)) { Fault(h, "get"); return true; }
                if ((t.ControlMask & ExecutionSpeed) == 0) Tag(h, pid, ctime, t);
                return true;
            }
        }

        static void Tag(SafeHandle query, uint pid, long ctime, Throttle t)
        {
            using (var h = OpenProcess(SetInformation, false, pid))
            {
                if (h.IsInvalid)
                {
                    int code = Marshal.GetLastWin32Error();
                    long seen;
                    if (code == Gone || Exited(query)) raced++;
                    else if (code != AccessDenied) Error("open-set", code);
                    else if (!unreachableSeen.TryGetValue(pid, out seen) || seen != ctime) { unreachable++; unreachableSeen[pid] = ctime; }
                    return;
                }
                t.ControlMask |= ExecutionSpeed;
                t.StateMask &= ~ExecutionSpeed;
                if (SetProcessInformation(h, PowerThrottling, ref t, ThrottleSize)) tagged++; else Fault(query, "set");
            }
        }

        static void Fault(SafeHandle h, string op)
        {
            int code = Marshal.GetLastWin32Error();
            if (Exited(h)) raced++; else Error(op, code);
        }

        static string Raise(SafeHandle h, bool force, out bool changed)
        {
            changed = false;
            var t = new Throttle();
            t.Version = 1;
            if (!GetProcessInformation(h, PowerThrottling, ref t, ThrottleSize)) { lastError = Marshal.GetLastWin32Error(); return "get"; }
            if (!force && (t.ControlMask & ExecutionSpeed) != 0) return null;
            t.ControlMask |= ExecutionSpeed;
            t.StateMask &= ~ExecutionSpeed;
            if (!SetProcessInformation(h, PowerThrottling, ref t, ThrottleSize)) { lastError = Marshal.GetLastWin32Error(); return "set"; }
            changed = true;
            return null;
        }

        static bool Ctime(SafeHandle h, out long ctime)
        {
            long exit, kernel, user;
            if (GetProcessTimes(h, out ctime, out exit, out kernel, out user)) return true;
            Error("times", Marshal.GetLastWin32Error());
            return false;
        }

        static bool Exited(SafeHandle h)
        {
            uint code;
            if (GetExitCodeProcess(h, out code)) return code != StillActive;
            Error("exit-code", Marshal.GetLastWin32Error());
            return false;
        }

        static long CpuMs()
        {
            long create, exit, kernel, user;
            if (!GetProcessTimes(self, out create, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return (kernel + user) / 10000;
        }

        static void Error(string op, long code)
        {
            errors++;
            string key = "op=" + op + " code=" + code;
            int count;
            windowErrors.TryGetValue(key, out count);
            windowErrors[key] = count + 1;
        }

        static void Report(long cpuMs)
        {
            foreach (var e in windowErrors) Emit("error " + e.Key + " count=" + e.Value);
            tickTimes.Sort();
            long p50 = (long)Math.Round(tickTimes[(tickTimes.Count - 1) / 2]);
            long max = (long)Math.Round(tickTimes[tickTimes.Count - 1]);
            Emit("stats tagged=" + tagged + " raced=" + raced + " recycled=" + recycled + " unreachable=" + unreachable +
                " unknown=" + unknown + " errors=" + errors + " procs=" + procs + " tickMs=" + p50 + "/" + max + " cpuMs=" + cpuMs);
            tagged = raced = recycled = unreachable = unknown = errors = 0;
            windowErrors.Clear();
            tickTimes.Clear();
        }

        static void EmitError(string op, int code)
        {
            Emit("error op=" + op + " code=" + code + " count=1");
        }

        static void Emit(string line)
        {
            if (line.Length > MaxLine) line = line.Substring(0, MaxLine);
            Console.Out.Write(line + (char)10);
            Console.Out.Flush();
        }
    }
}
`;
