#!/bin/bash

# get the list of all categories and genres
curl -s https://pcradio.app/sitemaps/genres/ | htmlq loc | awk -F '/' '{print $5}' > genres.txt
curl -s https://pcradio.app/sitemaps/countries/ | htmlq loc | awk -F '/' '{print $5}' > countries.txt

# extract everything from the api
for i in $(cat genres.txt) ; do echo "#EXTM3U" > "${i}.m3u" ; for j in {1..100} ; do curl -s "https://pcradio.app/api/site/v2/stations/browse/?page=$j&page_size=60&sort=popular&genre=$i&lang=en" | jq -r '.results[]? | "#EXTINF:-1 tv-logo=\"\(.logo_url)\",\(.name)\n\(.streams[0].url)"' >> "${i}.m3u" ; done ; done
for i in $(cat countries.txt) ; do echo "#EXTM3U" > "${i}.m3u" ; for j in {1..100} ; do curl -s "https://pcradio.app/api/site/v2/stations/browse/?page=$j&page_size=60&sort=popular&country=$i&lang=en" | jq -r '.results[]? | "#EXTINF:-1 tv-logo=\"\(.logo_url)\",\(.name)\n\(.streams[0].url)"' >> "${i}.m3u" ; done ; done
