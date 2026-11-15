'use strict';
(() => {
 const form=document.getElementById('loginForm');if(!form)return;
 const button=document.createElement('button');button.type='button';button.className='button secondary';button.id='forgotPasswordButton';button.textContent='He olvidado mi contraseña';form.after(button);
 const dialog=document.createElement('dialog');dialog.className='manager-dialog security-dialog';dialog.id='passwordRecoveryDialog';
 dialog.innerHTML="<div class=\"section-title\"><h2>Recuperar la contraseña</h2><button type=\"button\" class=\"button secondary\" id=\"recoveryClose\">Cerrar</button></div><p>Hazlo en el PC donde está instalado el panel.</p><ol><li>Abre Inicio → Wolf MC Panel → Restablecer contraseña.</li><li>Confirma en Windows. Minecraft seguirá encendido.</li><li>Entra con la clave temporal que se abrirá y crea una contraseña nueva.</li></ol><p>Se cierran las sesiones y el acceso queda limitado a este PC hasta volver a activar LAN o HTTPS.</p><p>Se conserva una copia del acceso anterior. Tus servidores, mundos y mods no se borran.</p><details><summary>Sin instalador o panel personal</summary><p>Sin instalador: ejecuta scripts/recuperar-contrasena.ps1. En el panel personal, utiliza su acceso de recuperación de Windows.</p></details><p class=\"hint\">No compartas la clave temporal. Necesitas acceso a la cuenta de Windows del servidor.</p>";
 document.body.append(dialog);button.addEventListener('click',()=>dialog.showModal());document.getElementById('recoveryClose').addEventListener('click',()=>dialog.close());
})();
