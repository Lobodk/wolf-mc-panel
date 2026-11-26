function Grant-WolfBatchLogon([Security.Principal.SecurityIdentifier]$sid) {
    if (!('WolfMCBatchRight' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class WolfMCBatchRight {
    [StructLayout(LayoutKind.Sequential)]
    struct Attributes {
        public uint Length;
        public IntPtr RootDirectory, ObjectName;
        public uint Flags;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct UnicodeString {
        public ushort Length, MaximumLength;
        [MarshalAs(UnmanagedType.LPWStr)] public string Buffer;
    }
    [DllImport("advapi32.dll")]
    static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")]
    static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, [In] UnicodeString[] rights, uint count);
    [DllImport("advapi32.dll")]
    static extern uint LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll")]
    static extern uint LsaClose(IntPtr policy);
    static void Check(uint status) {
        if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
    }
    public static void Grant(byte[] sid) {
        const string name = "SeBatchLogonRight";
        var attributes = new Attributes { Length = (uint)Marshal.SizeOf(typeof(Attributes)) };
        IntPtr policy;
        Check(LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x810, out policy));
        try {
            var right = new UnicodeString { Length = (ushort)(name.Length * 2), MaximumLength = (ushort)((name.Length + 1) * 2), Buffer = name };
            Check(LsaAddAccountRights(policy, sid, new [] { right }, 1));
        } finally { LsaClose(policy); }
    }
}
'@
    }
    $sidBytes = [byte[]]::new($sid.BinaryLength)
    $sid.GetBinaryForm($sidBytes,0)
    [WolfMCBatchRight]::Grant($sidBytes)
}
