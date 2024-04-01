#!/bin/bash

# get a list of genres
curl -s https://www.streamfinder.com/internet-radio-search/genre/ | htmlq -a href a | grep "/genre/" | awk -F '/' '{print $4}' | sed 's| |+|g' > genres.txt 

# scrape everything
for i in "" \?page={2..100}\& ; do for j in $(cat genres.txt) ; do curl -s https://www.streamfinder.com/internet-radio-search/genre/$j/$i | htmlq .playbut -r '.span3, .alert' | grep "stname" | awk -F '"' '{print "#EXTINF:-1,"$8"\n"$10}' | sed 's/\;//g' | sed '/^$/d' >> A-$j.txt ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
