#!/bin/bash

# get a list of genres,and countries
curl -s https://webradiodirectory.com/ | htmlq .wp-radio-search option | sed -e 's|<option value="||g' -e 's|">|-|g' -e 's|</option>||g' -e 's| |_|g' -e 's|/|+|g' | grep -v "\-Select" > list.txt
cat list.txt | grep -v '^[0-9]' > countires.txt
cat list.txt | grep '^[0-9]' > genres.txt

# get the links to genres
for i in $(cat genres.txt) ; do curl -s https://webradiodirectory.com/\?keyword\&country\&genre\=$(echo $i | awk -F '-' '{print $1}')\&perpage\=20000\&sort\=asc | htmlq -a href .wp-radio-listings a | grep "station" | uniq | awk -F '/' '{print $5}' > A-$(echo $i | awk -F '-' '{print $2}').txt ; echo $i ; done

# get the links to countires
for i in $(cat countires.txt) ; do curl -s https://webradiodirectory.com/\?keyword\&country\=$(echo $i | awk -F '-' '{print $1}')\&genre\&perpage\=20000\&sort\=asc | htmlq -a href .wp-radio-listings a | grep "station" | uniq | awk -F '/' '{print $5}' > A-$(echo $i | awk -F '-' '{print $2}').txt ; echo $i ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://webradiodirectory.com/station/$j/ > mep1 ; cat mep1 | htmlq -t h1 | awk NF | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "onclick=" | head -n 1 | sed 's|\\||g' | awk -F '"' '{print $(NF-1)}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
