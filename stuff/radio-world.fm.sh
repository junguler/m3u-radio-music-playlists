#!/bin/bash

# get the list of all stations from the api
curl -s https://radioworld.fm/api/get_stations.php > stations.json

# convert the json payload to m3u playlists, divided by country
jq -r '.[] | [.country, .name, .city, .stream_url] | @tsv' stations.json | awk -F'\t' '{c=($1==""||$1=="null")?"Unknown":$1; gsub(/[\x00-\x1F]/,"",$2); f=c".m3u"; if(!s[f]++) print "#EXTM3U" > f; printf "#EXTINF:-1,%s - %s - %s\n%s\n", $2, c, $3, $4 >> f}'

# change spaces in the file names to underlines
for i in *.m3u ; mv $i $(echo $i | sed 's| |_|g') ; end
