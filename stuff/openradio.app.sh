#!/bin/bash

# find genres, countries and languages
curl -s https://openradio.app/music | htmlq -a href a | grep "genre" | sort | awk -F '/' '{print $3}' > genres.txt
curl -s https://openradio.app/by-language | htmlq -a href a | grep "by-language" | sort | awk -F '/' '{print $3}' | awk NF > languages.txt
for i in "africa" "asia" "central-america" "europe" "north-america" "oceania" "south-america" ; do curl -s https://openradio.app/api/by-location/$i | jq -r '.countries[].code' >> countries.txt ; done

# find pages for each category
for i in "" \?skip={12..1200..12} ; do for j in $(cat genres.txt) ; do curl -s https://openradio.app/api/list/global-genre/$j$i | jq -r '.items[] | {slug, id} | join("-")' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?skip={12..1200..12} ; do for j in $(cat languages.txt) ; do curl -s https://openradio.app/api/list/by-language/$j$i | jq -r '.items[] | {slug, id} | join("-")' | awk NF >> A-lang-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?skip={12..1200..12} ; do for j in $(cat countries.txt) ; do curl -s https://openradio.app/api/list/by-location/country/$j$i | jq -r '.items[] | {slug, id} | join("-")' | awk NF >> A-loca-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://openradio.app/station/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | htmlq script | sed 's/\\//g' | grep -Po '"url": *\K"[^"]*"' | sed 's/"//g' | head -n 1 | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
