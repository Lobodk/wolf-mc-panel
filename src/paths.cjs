'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function defaultDataDir(){if(process.env.WOLF_PANEL_DATA||process.env.LOBO_PANEL_DATA)return process.env.WOLF_PANEL_DATA||process.env.LOBO_PANEL_DATA;const base=process.env.LOCALAPPDATA||os.homedir(),old=path.join(base,'LoboServerPanel','data');return fs.existsSync(old)?old:path.join(base,'WolfMCPanel','data');}
module.exports={defaultDataDir};
