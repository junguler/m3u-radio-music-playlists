#!/bin/bash

# get a list of all the cities
curl -s https://worldradiomap.com/list/ | htmlq -a href a | sort | uniq | grep -v "about\|twitter\|links\|list" | awk 'length>2' > list.txt

# find all cities in radiomap.eu
for i in $(cat list.txt | grep "radiomap.eu") ; do curl -s $i | htmlq -a href a | grep "\../" | awk 'length>10' | grep -v "about" | sed -e 's/\.htm//g' -e 's|\.\.||g' > A-$(echo $i | awk -F '/' '{print $4"-"$5}').txt ; echo $i ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiomap.eu$j > mep1 ; cat mep1 | htmlq -t | awk NF | head -n 1 | awk '{print "#EXTINF:-1,"$0}' >> B$i ; cat mep1 | grep "<audio" | awk -F '"' '{print $6}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
