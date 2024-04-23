#!/bin/bash

# get a list of genres and countries
curl -s https://liveradio24.com/genres | htmlq -a href a | grep "/genres/" | sort | uniq | awk -F '/' '{print $3}' > genres.txt 
curl -s https://liveradio24.com/countries | htmlq -a href a | grep "/countries/" | sort | uniq | awk -F '/' '{print $3}' > countries.txt

# get the links to genres
for i in "" \?page={2..50} ; do for j in $(cat genres.txt) ; do curl -s https://liveradio24.com/genres/$j$i | htmlq -a href a | grep "/radio/" | uniq | awk -F '/' '{print $3}' >> A-$j.txt ; echo "$j - $i" ; done ; done

# get the links to countires
for i in "" \?page={2..50} ; do for j in $(cat countries.txt) ; do curl -s https://liveradio24.com/countries/$j$i | htmlq -a href a | grep "/radio/" | uniq | awk -F '/' '{print $3}' >> A-$j.txt ; echo "$j - $i" ; done ; done

# get the popular streams
for i in "" \?page={2..50} ; do curl -s https://liveradio24.com/popular$i | htmlq -a href a | grep "/radio/" | uniq | awk -F '/' '{print $3}' >> A-popular.txt ; echo "popular - $i" ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://liveradio24.com/radio/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep -Po '"streamLink": *\K"[^"]*"' | sed 's|"||g' | sed 's|;||g' | head -n 1 >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
