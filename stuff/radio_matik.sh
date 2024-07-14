#!/bin/bash

# get the list of countries, all pages have these i've decided one randomly
curl -s https://radiomatik.com/usa/ | htmlq -a href a | awk -F '/' '{print $4}' | sort | uniq | awk NF > countries.txt

# get the links to everything
for i in $(cat countries.txt) ; do curl -s https://radiomatik.com/stations/$i | htmlq table -a href a | awk -F '/' '{print $5}' > A-$i.txt ; done

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s http://play.radiomatik.com/play/$j > mep1 ; cat mep1 | htmlq -t h5 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep '<source' | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
