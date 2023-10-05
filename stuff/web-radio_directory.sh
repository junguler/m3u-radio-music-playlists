#!/bin/bash

# get a list of genres
curl -s http://radio.alltrack.org/ | htmlq -a href a | grep -v "genre" | grep "listen-online" | awk -F '/' '{print $4}' | sed 's|-listen-online||g' > genres.txt

# get the links to genres
for i in $(cat genres.txt) ; do curl -s https://radio.alltrack.org/$i-listen-online | htmlq -a href a | grep "//radio" | awk -F '/' '{print $4}' | awk NF | uniq > A-$i.txt ; echo $i ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radio.alltrack.org/$j > mep1 ; cat mep1 | htmlq -t h1 | head -n 1 | sed -e 's|Listen ||g' -e 's| Online||g' | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "source" | awk -F '"' '{print $2}' | sed 's|;||g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
