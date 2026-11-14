import java.lang.instrument.Instrumentation;
import java.lang.reflect.*;
import java.net.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.io.*;

/** Private read-only registry bridge. No transformed classes, network uploads, gameplay hooks or dependencies. */
public final class RegistryAgent {
 public static void premain(String configPath, final Instrumentation instrumentation) {
  try {
   final Properties config=new Properties();try(InputStream in=Files.newInputStream(Paths.get(configPath))){config.load(in);}
   Thread thread=new Thread(new Runnable(){public void run(){
    long end=System.currentTimeMillis()+600000L;
    while(System.currentTimeMillis()<end){
     try{Thread.sleep(2000);try(Socket socket=new Socket()){socket.connect(new InetSocketAddress(config.getProperty("host","127.0.0.1"),Integer.parseInt(config.getProperty("port"))),500);}
      if(export(config,instrumentation))return;
     }catch(Exception ignored){}
    }
    System.err.println("[Lobodk item catalog] Registry bridge unavailable for this version; game server was not modified.");
   }},"Lobodk private registry catalog");thread.setDaemon(true);thread.start();
  }catch(Exception e){System.err.println("[Lobodk item catalog] Could not initialize registry bridge.");}
 }
 private static List<String> names(Properties p,String key,String defaults){return Arrays.asList((p.getProperty(key,defaults)+";"+defaults).split(";"));}
 private static Method method(Class<?> type,List<String> names,int params){for(Method m:type.getMethods())if(names.contains(m.getName())&&m.getParameterTypes().length==params&&!Modifier.isStatic(m.getModifiers())){m.setAccessible(true);return m;}return null;}
 private static String quote(String value){StringBuilder b=new StringBuilder("\"");for(char c:value.toCharArray()){if(c=='"'||c=='\\')b.append('\\').append(c);else if(c<' ')b.append(String.format("\\u%04x",(int)c));else b.append(c);}return b.append('"').toString();}
 public static boolean export(Properties p,Instrumentation instrumentation)throws Exception{
  List<String> classes=names(p,"classes","net.minecraft.core.registries.BuiltInRegistries;net.minecraft.core.Registry");
  for(Class<?> type:instrumentation.getAllLoadedClasses()){
   if(!classes.contains(type.getName()))continue;
   for(Field field:type.getDeclaredFields()){
    if(!names(p,"fields","ITEM").contains(field.getName())||!Modifier.isStatic(field.getModifiers()))continue;
    field.setAccessible(true);Object registry=field.get(null);if(!(registry instanceof Iterable))continue;
    List<Method> keys=new ArrayList<Method>();for(Method m:registry.getClass().getMethods())if(names(p,"keys","getKey").contains(m.getName())&&m.getParameterTypes().length==1&&m.getParameterTypes()[0]==Object.class){m.setAccessible(true);keys.add(m);}
    if(keys.isEmpty())continue;
    StringBuilder items=new StringBuilder();Set<String> ids=new HashSet<String>();Set<String> namespaces=new TreeSet<String>();
    for(Object item:(Iterable<?>)registry){
     String id=null;for(Method m:keys){try{Object key=m.invoke(registry,item);if(key!=null&&key.toString().matches("[a-z0-9_.-]+:[a-z0-9_./-]+")){id=key.toString();break;}}catch(Exception ignored){}}
     if(id==null||id.equals("minecraft:air")||!ids.add(id))continue;
     Method description=method(item.getClass(),names(p,"descriptions","getDescriptionId"),0);String nameKey="item."+id.replace(':','.').replace('/','.');try{if(description!=null&&description.getReturnType()==String.class)nameKey=(String)description.invoke(item);}catch(Exception ignored){}
     Method stack=method(item.getClass(),names(p,"stacks","getDefaultMaxStackSize;getMaxStackSize"),0);int max=64;try{if(stack!=null&&stack.getReturnType()==int.class)max=((Number)stack.invoke(item)).intValue();}catch(Exception ignored){}
     if(items.length()>0)items.append(',');items.append("{\"id\":").append(quote(id)).append(",\"translationKey\":").append(quote(nameKey)).append(",\"fallbackName\":\"\",\"maxStackSize\":").append(Math.max(1,max)).append('}');namespaces.add(id.substring(0,id.indexOf(':')));
    }
    if(ids.size()<100)continue;
    StringBuilder mods=new StringBuilder();for(String ns:namespaces){if(mods.length()>0)mods.append(',');mods.append("{\"id\":").append(quote(ns)).append(",\"name\":").append(quote(ns.equals("minecraft")?"Minecraft":ns)).append(",\"version\":\"\"}");}
    StringBuilder files=new StringBuilder();Path modDir=Paths.get("mods");if(Files.isDirectory(modDir))try(DirectoryStream<Path> stream=Files.newDirectoryStream(modDir,"*.jar")){for(Path file:stream){if(!Files.isRegularFile(file))continue;if(files.length()>0)files.append(',');files.append("{\"name\":").append(quote(file.getFileName().toString())).append(",\"size\":").append(Files.size(file)).append(",\"modifiedAt\":").append(Files.getLastModifiedTime(file).toMillis()).append('}');}}
    String json="{\"schema\":1,\"moduleVersion\":\"portable-registry-1\",\"generatedAt\":"+System.currentTimeMillis()+",\"minecraftVersion\":"+quote(p.getProperty("version",""))+",\"mods\":["+mods+"],\"modFiles\":["+files+"],\"items\":["+items+"]}";
    Path output=Paths.get(p.getProperty("output"));Files.createDirectories(output.getParent());Path temp=output.resolveSibling(output.getFileName()+".portable.tmp");Files.write(temp,json.getBytes(StandardCharsets.UTF_8));try{Files.move(temp,output,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}catch(AtomicMoveNotSupportedException e){Files.move(temp,output,StandardCopyOption.REPLACE_EXISTING);}
    System.out.println("[Lobodk item catalog] Exported "+ids.size()+" registered items.");return true;
   }
  }
  return false;
 }
}
