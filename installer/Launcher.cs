using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
class Launcher {
 [STAThread] static void Main(string[] args) {
  try {
   string root=AppDomain.CurrentDomain.BaseDirectory;
   string arguments="\""+Path.Combine(root,"src","desktop.cjs")+"\"";
   foreach(string argument in args) if(argument=="--stop"||argument=="--no-browser"||argument=="--local") arguments+=" "+argument;
   ProcessStartInfo info=new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"),arguments);
   info.WorkingDirectory=root;info.UseShellExecute=false;info.CreateNoWindow=true;Process.Start(info);
  } catch(Exception error) {MessageBox.Show(error.Message,"Wolf MC Panel",MessageBoxButtons.OK,MessageBoxIcon.Error);}
 }
}
