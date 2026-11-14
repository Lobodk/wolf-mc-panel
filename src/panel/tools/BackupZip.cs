using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Text.RegularExpressions;

public static class WolfBackupZip {
 static string Inside(string root,string relative){
  string basePath=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
  if(String.IsNullOrEmpty(relative)||relative.StartsWith("/")||relative.StartsWith("\\")||Path.IsPathRooted(relative))throw new IOException("Absolute archive path rejected.");
  string[] parts=relative.Replace('\\','/').TrimEnd('/').Split('/');
  foreach(string part in parts)if(part.Length==0||part=="."||part==".."||Regex.IsMatch(part,@"[<>:""|?*\x00-\x1f]|[ .]$")||Regex.IsMatch(part,@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$",RegexOptions.IgnoreCase))throw new IOException("Unsafe archive path rejected.");
  string target=Path.GetFullPath(Path.Combine(root,String.Join(Path.DirectorySeparatorChar.ToString(),parts)));
  if(!target.StartsWith(basePath,StringComparison.OrdinalIgnoreCase))throw new IOException("Archive path escapes destination.");return target;
 }
 static void Add(ZipArchive zip,string root,string relative){
  string file=Inside(root,relative);FileAttributes attributes=File.GetAttributes(file);
  if((attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Links are not included in backups: "+relative);
  if((attributes&FileAttributes.Directory)!=0){zip.CreateEntry(relative.Replace('\\','/').TrimEnd('/')+"/");foreach(string child in Directory.GetFileSystemEntries(file))Add(zip,root,relative+"/"+Path.GetFileName(child));return;}
  if(Path.GetFileName(file).Equals("session.lock",StringComparison.OrdinalIgnoreCase))return;
  ZipArchiveEntry entry=zip.CreateEntry(relative.Replace('\\','/'),CompressionLevel.Optimal);
  DateTime timestamp=File.GetLastWriteTime(file);if(timestamp.Year>=1980&&timestamp.Year<=2107)entry.LastWriteTime=new DateTimeOffset(timestamp);
  using(FileStream input=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(Stream output=entry.Open())input.CopyTo(output);
 }
 public static void Create(string archive,string root,string[] entries){using(FileStream output=new FileStream(archive,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None))using(ZipArchive zip=new ZipArchive(output,ZipArchiveMode.Create)){foreach(string relative in entries)Add(zip,root,relative);}}
 public static string[] List(string archive){var names=new List<string>();using(ZipArchive zip=ZipFile.OpenRead(archive)){foreach(ZipArchiveEntry entry in zip.Entries)names.Add(entry.FullName);}return names.ToArray();}
 public static void Extract(string archive,string root){
  var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);using(ZipArchive zip=ZipFile.OpenRead(archive)){
   foreach(ZipArchiveEntry entry in zip.Entries){string target=Inside(root,entry.FullName);if(!seen.Add(target))throw new IOException("Duplicate archive path rejected.");
    if(((entry.ExternalAttributes>>16)&0xF000)==0xA000)throw new IOException("Symbolic link rejected.");
    if(entry.FullName.EndsWith("/")){Directory.CreateDirectory(target);continue;}
    Directory.CreateDirectory(Path.GetDirectoryName(target));using(Stream input=entry.Open())using(FileStream output=new FileStream(target,FileMode.CreateNew,FileAccess.Write,FileShare.None))input.CopyTo(output);
   }
  }
 }
}
