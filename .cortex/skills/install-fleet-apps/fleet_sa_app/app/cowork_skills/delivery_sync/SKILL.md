---
name: delivery-sync
description: Tell the receiving crew exactly when a load is on the floor, so they travel to site once and at the right time. Use for: Has the delivery actually arrived and left, so the crew that receives or installs it can be sent now rather than sent twice? Covers the Delivery Sync use case of the Fleet Intelligence accelerator.
---

# Delivery Sync

**Business question.** Has the delivery actually arrived and left, so the crew that receives or installs it can be sent now rather than sent twice?

**Who asks it.** Site or crew scheduler, Field operations manager, Delivery operations, Customer service

## How to answer

1. Use the `query_delivery_sync` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_delivery_sync cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - site visits detected for the service date
   - sites READY (unload complete, load on the floor - the vehicle may still be standing on the site)
   - site visits mid-unload at the replay instant (KPI card 'Unloads In Progress', readiness state IN_PROGRESS - counted per VISIT, from the unload window)
   - vehicles physically inside a site geofence at the replay instant (map 'vehicles' layer, status 'On site now' - counted per VEHICLE, from position)
   - sites still EXPECTED at the replay instant
   - average time on site in minutes
   - minutes out for inbound vehicles
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="delivery_sync", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Arrival, unload completion and departure are detected from the pings themselves, not from a status flag: every position ping is tested against the site's own radius (DIM_VEHICLE_DWELL_SLA.BUFFER_RADIUS_M), consecutive inside-pings are grouped into a visit, and the arrival/unload-complete pair is taken from the stationary core of that visit. Departure is a separate, stricter fact: the first ping actually observed OUTSIDE the geofence. Unload complete is typically a minute or two earlier, with the vehicle still parked inside the fence, so the feed reports the two moments separately rather than calling the first one a departure. Every site's 15-minute approach ring, and the inbound ETA, are computed live by the routing engine at the replay instant. The rings are drive-time, not radius, so they follow the road network; they are only distinguishable when you zoom in, which is why the focus site's ring is drawn more strongly. This page shows ONE service day, and the As Of card names the exact instant being replayed. The day is the busiest delivery day inside the global date range; if the selected range contains no deliveries at all, it falls back to the busiest day for the region so the page still shows something, and the As Of card is what tells you which day and time you are looking at. The replay clock steps in 10-minute increments, which is finer than the median time on site, so a typical delivery is visible while the vehicle is still there. On the map, hollow grey rings are the delivery sites and the smaller solid dots are vehicles, coloured only when their state is actionable: green on site, red just left, yellow inside the live drive-time approach band. En route and idle vehicles stay Snowflake blue so the eye lands on the few that matter. Idle is split in the tooltip between a vehicle that has finished its day and one with no delivery recorded at all - early in the day most idle vehicles are the second kind, and calling those "day complete" would misread. Grey is only ever site furniture and blue is only ever a vehicle, so the two classes cannot be confused. An optional Site geofence layer (off by default) draws each site's true 100-200 m detection radius; it is only legible zoomed in, because that is how big those circles really are. Vehicle status on the map is POSITIONAL: a vehicle counts as on site whenever its last known position falls inside the geofence of a site being served on the day shown, so the dot and the label can never disagree. Sites outside that day's plan are deliberately not eligible - the page draws only that day's circles, so a green dot on an unplanned yard would name a site nothing else on the page mentions; such a vehicle reads idle. The tooltip then separates the two phases - Unloading while the detected visit is still open, On site with unload complete once it has closed. Readiness in the tables and cards uses the unload window instead, which is why a site can read READY while the vehicle is still standing on it. Just left is a distance test too, not only a clock: a vehicle keeps the red colour while it is inside the same 15-minute drive-time band the ring draws, and once it is further out it is simply shown as heading to its next stop. The notification feed speaks the same three-way vocabulary, so a feed row and the map can never contradict each other: Arrived and Unload complete both leave the vehicle on site, and only Departed says it has gone. 

## Caveats you MUST state

A site reading EXPECTED is hindsight, not a forecast: the visit is in the data because it was detected later the same day. In production that state would come from the dispatch plan. READY and IN_PROGRESS are direct detections. A visit whose telemetry ends while the vehicle is still parked on the site gets no Departed row at all - on the New Jersey reference day that is 34 of 134 visits - because no departure was ever observed; the page says nothing rather than inventing one. The telemetry itself is synthetic.

## Questions this skill covers

- Which sites are ready for the crew right now?
- Has the vehicle left site X yet?
- How long did the vehicle spend at site X?
- Which vehicles are within 15 minutes of their next site?
- Which sites are still waiting on a delivery?

## What the answer is worth

- Stop the wasted second trip when a crew arrives before the load does
- Shorten the gap between delivery and the revenue-earning work that follows it
- Give the customer a credible arrival window instead of a day-long one
