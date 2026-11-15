'use strict';
const path=require('node:path'),os=require('node:os');
function defaultDataDir(){if(process.env.WOLF_PANEL_DATA||process.env.LOBO_PANEL_DATA)return process.env.WOLF_PANEL_DATA||process.env.LOBO_PANEL_DATA;return path.join(process.env.LOCALAPPDATA||os.homedir(),'WolfMCPanel','data');}
module.exports={defaultDataDir};
