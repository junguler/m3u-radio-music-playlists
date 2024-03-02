#!/bin/bash

# get a list of genres, countries and languages
curl -s https://radio.menu/ | htmlq -a href a | grep "tags" | awk -F '/' '{print $7}' > genres.txt
curl -s https://radio.menu/ | htmlq -a href a | grep "langs" | awk -F '/' '{print $7}' > languages.txt
curl -s https://radio.menu/ | htmlq -a href a | grep "country" | awk -F '/' '{print $7}' > countries.txt

# get the links to genres
for i in "" paged/{2..15}/ ; do for j in $(cat genres.txt) ; do curl -s https://radio.menu/stations/facet/tags/$j/$i | htmlq -a href a | grep "/stations/" | grep -v "radio.menu" | awk -F '/' '{print $3}' >> A-$j.txt ; echo "$j - $i" ; done ; done

# get the links to countires
for i in "" paged/{2..15}/ ; do for j in $(cat countries.txt) ; do curl -s https://radio.menu/stations/facet/country/$j/$i | htmlq -a href a | grep "/stations/" | grep -v "radio.menu" | awk -F '/' '{print $3}' >> A-loca-$j.txt ; echo "$j - $i" ; done ; done

# get the links to languages
for i in "" paged/{2..25}/ ; do for j in $(cat languages.txt) ; do curl -s https://radio.menu/stations/facet/langs/$j/$i | htmlq -a href a | grep "/stations/" | grep -v "radio.menu" | awk -F '/' '{print $3}' >> A-lang-$j.txt ; echo "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radio.menu/stations/$j/ > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "data-streams" | head -n 1 | awk -F '"' '{print $4}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
