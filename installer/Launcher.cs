using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
class Launcher {
 [STAThread] static void Main(string[] args) {
  try {
   string root=AppDomain.CurrentDomain.BaseDirectory;
   string arguments="\""+Path.Combine(root,"src","desktop.cjs")+"\"";
   if(Array.IndexOf(args,"--reset-password")>=0) {
    if(MessageBox.Show("Se cerrará únicamente el panel y sus sesiones. Se guardará una copia de la configuración de acceso y se generará una clave temporal nueva.\n\nLos servidores de Minecraft y sus mundos no se borrarán ni se apagarán. Por seguridad, el panel quedará accesible solo desde este PC hasta que configures una contraseña nueva y vuelvas a habilitar LAN o HTTPS.\n\n¿Quieres restablecer la contraseña de este panel?","Wolf MC Panel · Recuperación local",MessageBoxButtons.YesNo,MessageBoxIcon.Warning,MessageBoxDefaultButton.Button2)!=DialogResult.Yes)return;
    arguments+=" --reset-password --confirm-local-reset";
   }
   foreach(string argument in args) if(argument=="--start-configured-server"||argument=="--stop"||argument=="--no-browser"||argument=="--local") arguments+=" "+argument;
   ProcessStartInfo info=new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"),arguments);
   info.WorkingDirectory=root;info.UseShellExecute=false;info.CreateNoWindow=true;Process.Start(info);
  } catch(Exception error) {MessageBox.Show(error.Message,"Wolf MC Panel",MessageBoxButtons.OK,MessageBoxIcon.Error);}
 }
}
