#!/bin/bash

# find genres and countries
curl -s https://www.getmeradio.com/stations/genre/ | htmlq -a href a | grep "genre" | awk -F '/' '{print $4}' | awk NF | sort | uniq > genres.txt
curl -s https://www.getmeradio.com/stations/country/ | htmlq -a href a | grep "country" | awk -F '/' '{print $4}' | awk NF | sort | uniq > countries.txt

# find pages for each category
for i in $(cat genres.txt) ; do curl -s -L https://www.getmeradio.com/stations/genre/$i | htmlq -a href a | grep "stations" | awk -F '/' '{print $3}' | awk 'NR>4' > A-$i.txt ; done
for i in $(cat countries.txt) ; do curl -s -L https://www.getmeradio.com/stations/country/$i | htmlq -a href a | grep "stations" | awk -F '/' '{print $3}' | awk 'NR>2' > A-$i.txt ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s -L https://www.getmeradio.com/stations/$j/ > mep1 ; cat mep1 | htmlq -t h2 -r .listing-tag | head -n 1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep "var audio = new Audio" | awk -F '"' '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove offair and some redirections
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -v "Station Not Available" | grep -B1 "http" | awk 'length>4' | sed 's|https://securestreams7.autopo.st/?uri=||g' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
