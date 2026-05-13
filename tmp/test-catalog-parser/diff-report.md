# Catalog parser fix diff report

Generated: 2026-05-13T08:23:35.184Z

## Summary
| Set | Total | Continents | Countries | Sub-regions | Cities |
|---|---|---|---|---|---|
| Baseline | 460 | 8 | 204 | 10 | 238 |
| OLD | 699 | 8 | 204 | 249 | 238 |
| NEW | 699 | 8 | 204 | 249 | 238 |

## NEW sub-region coverage
| Region | Count |
|---|---|
| US states | 53 |
| Canadian provinces | 13 |
| German Länder | 16 |
| French régions | 27 |
| Italian regions | 5 |
| Russia sub-regions (regression guard) | 10 |

## Pass criteria
- [x] OLD reproduces all continents in baseline
- [x] OLD reproduces >=95% of country count
- [x] OLD reproduces all BBBike cities
- [x] NEW continents == OLD continents
- [x] NEW countries >= OLD countries
- [x] NEW cities == OLD cities
- [x] NEW does not change PBF URL of any continent / country / city
- [x] NEW: >=40 US states
- [x] NEW: >=10 Canadian provinces
- [x] NEW: >=10 German Länder
- [x] NEW: >=15 French régions
- [x] NEW: >=5 Italian macroregions (Geofabrik only exposes 5)
- [x] NEW: Russia sub-regions == 10 (regression)
- [x] NEW: dedup keys unique
- [x] HEAD-check: all sampled NEW URLs return 200 (20/20)
- [x] HEAD-check: OLD URLs were broken on at least 50% of changed rows (broken=20, stillOk=0)

## Rows with PBF URL change OLD→NEW (must be empty)
- geofabrik:sub-region:Anhui:China
   OLD: https://download.geofabrik.de/china/anhui-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/anhui-latest.osm.pbf
- geofabrik:sub-region:Beijing:China
   OLD: https://download.geofabrik.de/china/beijing-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/beijing-latest.osm.pbf
- geofabrik:sub-region:Chongqing:China
   OLD: https://download.geofabrik.de/china/chongqing-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/chongqing-latest.osm.pbf
- geofabrik:sub-region:Fujian:China
   OLD: https://download.geofabrik.de/china/fujian-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/fujian-latest.osm.pbf
- geofabrik:sub-region:Gansu:China
   OLD: https://download.geofabrik.de/china/gansu-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/gansu-latest.osm.pbf
- geofabrik:sub-region:GuangdongwithHongKongAndMacau:China
   OLD: https://download.geofabrik.de/china/guangdong-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/guangdong-latest.osm.pbf
- geofabrik:sub-region:Guangxi:China
   OLD: https://download.geofabrik.de/china/guangxi-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/guangxi-latest.osm.pbf
- geofabrik:sub-region:Guizhou:China
   OLD: https://download.geofabrik.de/china/guizhou-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/guizhou-latest.osm.pbf
- geofabrik:sub-region:Hainan:China
   OLD: https://download.geofabrik.de/china/hainan-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/hainan-latest.osm.pbf
- geofabrik:sub-region:HebeiwithBeijingAndTianjin:China
   OLD: https://download.geofabrik.de/china/hebei-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/hebei-latest.osm.pbf
- geofabrik:sub-region:Heilongjiang:China
   OLD: https://download.geofabrik.de/china/heilongjiang-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/heilongjiang-latest.osm.pbf
- geofabrik:sub-region:Henan:China
   OLD: https://download.geofabrik.de/china/henan-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/henan-latest.osm.pbf
- geofabrik:sub-region:HongKong:China
   OLD: https://download.geofabrik.de/china/hong-kong-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/hong-kong-latest.osm.pbf
- geofabrik:sub-region:Hubei:China
   OLD: https://download.geofabrik.de/china/hubei-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/hubei-latest.osm.pbf
- geofabrik:sub-region:Hunan:China
   OLD: https://download.geofabrik.de/china/hunan-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/hunan-latest.osm.pbf
- geofabrik:sub-region:InnerMongolia:China
   OLD: https://download.geofabrik.de/china/inner-mongolia-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/inner-mongolia-latest.osm.pbf
- geofabrik:sub-region:Jiangsu:China
   OLD: https://download.geofabrik.de/china/jiangsu-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/jiangsu-latest.osm.pbf
- geofabrik:sub-region:Jiangxi:China
   OLD: https://download.geofabrik.de/china/jiangxi-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/jiangxi-latest.osm.pbf
- geofabrik:sub-region:Jilin:China
   OLD: https://download.geofabrik.de/china/jilin-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/jilin-latest.osm.pbf
- geofabrik:sub-region:Liaoning:China
   OLD: https://download.geofabrik.de/china/liaoning-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/liaoning-latest.osm.pbf
- geofabrik:sub-region:Macau:China
   OLD: https://download.geofabrik.de/china/macau-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/macau-latest.osm.pbf
- geofabrik:sub-region:Ningxia:China
   OLD: https://download.geofabrik.de/china/ningxia-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/ningxia-latest.osm.pbf
- geofabrik:sub-region:Qinghai:China
   OLD: https://download.geofabrik.de/china/qinghai-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/qinghai-latest.osm.pbf
- geofabrik:sub-region:Shaanxi:China
   OLD: https://download.geofabrik.de/china/shaanxi-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/shaanxi-latest.osm.pbf
- geofabrik:sub-region:Shandong:China
   OLD: https://download.geofabrik.de/china/shandong-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/shandong-latest.osm.pbf
- geofabrik:sub-region:Shanghai:China
   OLD: https://download.geofabrik.de/china/shanghai-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf
- geofabrik:sub-region:Shanxi:China
   OLD: https://download.geofabrik.de/china/shanxi-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/shanxi-latest.osm.pbf
- geofabrik:sub-region:Sichuan:China
   OLD: https://download.geofabrik.de/china/sichuan-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/sichuan-latest.osm.pbf
- geofabrik:sub-region:Tianjin:China
   OLD: https://download.geofabrik.de/china/tianjin-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/tianjin-latest.osm.pbf
- geofabrik:sub-region:Tibet:China
   OLD: https://download.geofabrik.de/china/tibet-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/tibet-latest.osm.pbf
- geofabrik:sub-region:Xinjiang:China
   OLD: https://download.geofabrik.de/china/xinjiang-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/xinjiang-latest.osm.pbf
- geofabrik:sub-region:Yunnan:China
   OLD: https://download.geofabrik.de/china/yunnan-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/yunnan-latest.osm.pbf
- geofabrik:sub-region:Zhejiang:China
   OLD: https://download.geofabrik.de/china/zhejiang-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/china/zhejiang-latest.osm.pbf
- geofabrik:sub-region:CentralZone:India
   OLD: https://download.geofabrik.de/india/central-zone-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/india/central-zone-latest.osm.pbf
- geofabrik:sub-region:EasternZone:India
   OLD: https://download.geofabrik.de/india/eastern-zone-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/india/eastern-zone-latest.osm.pbf
- geofabrik:sub-region:NorthEasternZone:India
   OLD: https://download.geofabrik.de/india/north-eastern-zone-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/india/north-eastern-zone-latest.osm.pbf
- geofabrik:sub-region:NorthernZone:India
   OLD: https://download.geofabrik.de/india/northern-zone-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf
- geofabrik:sub-region:SouthernZone:India
   OLD: https://download.geofabrik.de/india/southern-zone-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/india/southern-zone-latest.osm.pbf
- geofabrik:sub-region:WesternZone:India
   OLD: https://download.geofabrik.de/india/western-zone-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/india/western-zone-latest.osm.pbf
- geofabrik:sub-region:Java:Indonesia (with East Timor)
   OLD: https://download.geofabrik.de/indonesia/java-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf
- geofabrik:sub-region:Kalimantan:Indonesia (with East Timor)
   OLD: https://download.geofabrik.de/indonesia/kalimantan-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/indonesia/kalimantan-latest.osm.pbf
- geofabrik:sub-region:Maluku:Indonesia (with East Timor)
   OLD: https://download.geofabrik.de/indonesia/maluku-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/indonesia/maluku-latest.osm.pbf
- geofabrik:sub-region:NusaTenggara:Indonesia (with East Timor)
   OLD: https://download.geofabrik.de/indonesia/nusa-tenggara-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/indonesia/nusa-tenggara-latest.osm.pbf
- geofabrik:sub-region:Papua:Indonesia (with East Timor)
   OLD: https://download.geofabrik.de/indonesia/papua-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/indonesia/papua-latest.osm.pbf
- geofabrik:sub-region:Sulawesi:Indonesia (with East Timor)
   OLD: https://download.geofabrik.de/indonesia/sulawesi-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/indonesia/sulawesi-latest.osm.pbf
- geofabrik:sub-region:Sumatra:Indonesia (with East Timor)
   OLD: https://download.geofabrik.de/indonesia/sumatra-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/indonesia/sumatra-latest.osm.pbf
- geofabrik:sub-region:ChbuRegion:Japan
   OLD: https://download.geofabrik.de/japan/chubu-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/japan/chubu-latest.osm.pbf
- geofabrik:sub-region:ChgokuRegion:Japan
   OLD: https://download.geofabrik.de/japan/chugoku-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/japan/chugoku-latest.osm.pbf
- geofabrik:sub-region:Hokkaid:Japan
   OLD: https://download.geofabrik.de/japan/hokkaido-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/japan/hokkaido-latest.osm.pbf
- geofabrik:sub-region:KansaiRegionakaKinkiRegion:Japan
   OLD: https://download.geofabrik.de/japan/kansai-latest.osm.pbf
   NEW: https://download.geofabrik.de/asia/japan/kansai-latest.osm.pbf

## Sample of NEW sub-region rows
- Anhui (asia/china) -> https://download.geofabrik.de/asia/china/anhui-latest.osm.pbf
- Beijing (asia/china) -> https://download.geofabrik.de/asia/china/beijing-latest.osm.pbf
- Chongqing (asia/china) -> https://download.geofabrik.de/asia/china/chongqing-latest.osm.pbf
- Fujian (asia/china) -> https://download.geofabrik.de/asia/china/fujian-latest.osm.pbf
- Gansu (asia/china) -> https://download.geofabrik.de/asia/china/gansu-latest.osm.pbf
- Guangdong (with Hong Kong and Macau) (asia/china) -> https://download.geofabrik.de/asia/china/guangdong-latest.osm.pbf
- Guangxi (asia/china) -> https://download.geofabrik.de/asia/china/guangxi-latest.osm.pbf
- Guizhou (asia/china) -> https://download.geofabrik.de/asia/china/guizhou-latest.osm.pbf
- Hainan (asia/china) -> https://download.geofabrik.de/asia/china/hainan-latest.osm.pbf
- Hebei (with Beijing and Tianjin) (asia/china) -> https://download.geofabrik.de/asia/china/hebei-latest.osm.pbf
- Heilongjiang (asia/china) -> https://download.geofabrik.de/asia/china/heilongjiang-latest.osm.pbf
- Henan (asia/china) -> https://download.geofabrik.de/asia/china/henan-latest.osm.pbf
- Hong Kong (asia/china) -> https://download.geofabrik.de/asia/china/hong-kong-latest.osm.pbf
- Hubei (asia/china) -> https://download.geofabrik.de/asia/china/hubei-latest.osm.pbf
- Hunan (asia/china) -> https://download.geofabrik.de/asia/china/hunan-latest.osm.pbf
- Inner Mongolia (asia/china) -> https://download.geofabrik.de/asia/china/inner-mongolia-latest.osm.pbf
- Jiangsu (asia/china) -> https://download.geofabrik.de/asia/china/jiangsu-latest.osm.pbf
- Jiangxi (asia/china) -> https://download.geofabrik.de/asia/china/jiangxi-latest.osm.pbf
- Jilin (asia/china) -> https://download.geofabrik.de/asia/china/jilin-latest.osm.pbf
- Liaoning (asia/china) -> https://download.geofabrik.de/asia/china/liaoning-latest.osm.pbf
- Macau (asia/china) -> https://download.geofabrik.de/asia/china/macau-latest.osm.pbf
- Ningxia (asia/china) -> https://download.geofabrik.de/asia/china/ningxia-latest.osm.pbf
- Qinghai (asia/china) -> https://download.geofabrik.de/asia/china/qinghai-latest.osm.pbf
- Shaanxi (asia/china) -> https://download.geofabrik.de/asia/china/shaanxi-latest.osm.pbf
- Shandong (asia/china) -> https://download.geofabrik.de/asia/china/shandong-latest.osm.pbf
- Shanghai (asia/china) -> https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf
- Shanxi (asia/china) -> https://download.geofabrik.de/asia/china/shanxi-latest.osm.pbf
- Sichuan (asia/china) -> https://download.geofabrik.de/asia/china/sichuan-latest.osm.pbf
- Tianjin (asia/china) -> https://download.geofabrik.de/asia/china/tianjin-latest.osm.pbf
- Tibet (asia/china) -> https://download.geofabrik.de/asia/china/tibet-latest.osm.pbf