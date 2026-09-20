RF Mapping Tool

Indoor and outdoor mobile signal coverage mapping for NBCC Fredericton.

Upload floor plans, place them on a real map, drop in drive-test or walk-test scan files, and see RSRP coverage as a heatmap, a route map, or a contour map. Everything is saved per user account in Supabase.

What it does:

Floor plans on real coordinates. Upload a plan image, assign it to a building and a level, then drag three handles to place it: move, rotate and scale, and set the depth. Buildings are rarely aligned north-up, so the placement is a full affine transform, not a north-up rectangle.

Indoor and outdoor in one map. Each row of a scan file is judged on its own. A row with a real GPS fix is plotted straight onto the map; a row without one carries floor-plan pixel coordinates instead, which are converted to real coordinates through the plan's placement. One file can contain both, which is what happens when a walk test goes indoors and the GPS fix drops.

Credits:

Built with these open source libraries, loaded from CDN:


Library Leaflet used for Map rendering and interaction, licence BSD-2-Clause
Library leaflet-control-geocoder used for Place search, licence BSD-2-Clause
Library Leaflet.heat used for Heat layer support, licence BSD-2-Clause
Library PapaParse used for CSV parsing, licence MIT
Library SheetJS	used for Excel parsing, licence Apache-2.0
Library html2canvas	used for PNG export,	licence MIT
Library supabase-js	used for Auth and database client, licence MIT
Library Flask used for Serving the pages, licence BSD-3-Clause
Library python-dotenv used for Reading .env, licence BSD-3-Clause

Map data and tiles:

Basemap data (c) OpenStreetMap contributors, licensed under the ODbL. Attribution is required wherever these maps are shown, including in exported images.
OSM-rendered tiles served by OSM France and CyclOSM.
Street, topographic, grey canvas and satellite tiles (c) Esri; satellite imagery (c) Esri, Maxar, Earthstar Geographics.

Marching squares and Inverse Distance Weighting are standard published methods; the implementations here are original.