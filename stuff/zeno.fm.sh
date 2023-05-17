#!/bin/bash

# find genres, countries and languages
curl -s https://zeno.fm/radio/genres/ | htmlq -a href a | uniq | grep "genres" | awk -F '/' '{print $6}' > genres.txt
curl -s https://zeno.fm/radio/countries/ | htmlq -a href a | uniq | grep "countries" | awk -F '/' '{print $6}' > countries.txt
curl -s https://zeno.fm/radio/languages/ | htmlq -a href a | uniq | grep "languages" | awk -F '/' '{print $6}' > languages.txt

# find pages for each category
for i in {1..100} ; do for j in $(cat genres.txt) ; do curl -s "https://zeno.fm/api/stations/?query=&limit=100&genre=$j&country=&language=&page=$i" | jq -r '.[].url' | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in {1..100} ; do for j in $(cat countries.txt) ; do curl -s "https://zeno.fm/api/stations/?query=&limit=100&genre=&country=$j&language=&page=$i" | jq -r '.[].url' | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in {1..100} ; do for j in $(cat languages.txt) ; do curl -s "https://zeno.fm/api/stations/?query=&limit=100&genre=&country=&language=$j&page=$i" | jq -r '.[].url' | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://zeno.fm/radio/$j/ > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep -Po '"streamURL": *\K"[^"]*"' | sed 's/"//g' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# replace %20 in file names with _
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/%20/_/')" ; done
