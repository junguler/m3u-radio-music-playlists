#!/bin/bash

# get a list of genre and countries
curl -s https://fmcube.net/ | htmlq -a href a | sort | uniq | awk 'length>4' | grep '/zhanr/' | awk -F '/' '{print $3}' > genres.txt
curl -s https://fmcube.net/ | htmlq -a href a | sort | uniq | awk 'length>4' | grep '/strana/' | awk -F '/' '{print $3}' > countries.txt

# scrape stream names from each page
for i in "" \?page={2..45}\&per-page=40 ; do for j in $(cat genres.txt) ; do curl -s https://fmcube.net/zhanr/$j$i | htmlq -a href a | grep '/radio/' | awk -F '/' '{print $3}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" \?page={2..5}\&per-page=40 ; do for j in $(cat countries.txt) ; do curl -s https://fmcube.net/strana/$j$i | htmlq -a href a | grep '/radio/' | awk -F '/' '{print $3}' >> A-$j.txt ; echo "$j - $i" ; done ; done

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://fmcube.net/radio/$j > mep1 ; cat mep1 | htmlq h1 -t | awk NF | awk '{$1=$1; print}' | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep 'data-quality=' | head -n 1 | awk -F "'" '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
