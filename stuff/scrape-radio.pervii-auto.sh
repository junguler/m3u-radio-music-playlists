#!/bin/bash

# scrape the links
lynx --dump --listonly --nonumbers https://www.radio.pervii.com/en/online-playlists-m3u.htm | grep ".m3u" | grep "top_radio" > c:/git/music-list.txt

# download the streams
aria2c --check-certificate=false -i c:/git/music-list.txt -d c:/git/bare_m3u/

# remove top_radio_ from the streams
for f in c:/git/bare_m3u/*.m3u ; do mv "$f" "$(echo "$f" | sed -e 's/top_radio_//g')"; done

# create everything-full stream
cat $( ls c:/git/bare_m3u/*.m3u -v ) | awk '!seen[$0]++' > c:/git/bare_m3u/---everything-full.m3u

# create everything-lite stream
cat c:/git/bare_m3u/---everything-full.m3u | sed -n '/^#/!p' > c:/git/bare_m3u/---everything-lite.m3u

# create randomized stream
cat c:/git/bare_m3u/---everything-lite.m3u | shuf > c:/git/bare_m3u/---randomized.m3u

# create sorted stream
cat c:/git/bare_m3u/---everything-lite.m3u | sort | awk 'length>10' > c:/git/bare_m3u/---sorted.m3u
