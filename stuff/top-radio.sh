#!/bin/bash

# get a list of genres and countries
curl -s https://top-radio.org/genre/ | htmlq -a href a | grep "/genre/" | sort | uniq | awk -F '/' '{print $5}' > genres.txt
curl -s https://top-radio.org/country/ | htmlq -a href a | sort | grep -v "about\|privacy\|contact" | uniq | awk -F '/' '{print $4}' | awk NF > countries.txt

# get the links to genres
for i in "" page/{2..25}/ ; do for j in $(cat genres.txt) ; do curl -s https://top-radio.org/genre/$j/$i | htmlq .entry-title -a href a | uniq | cut -c23- >> A-$j.txt ; echo "$j - $i" ; done ; done

# get the links to countires
for i in "" page/{2..25}/ ; do for j in $(cat countries.txt) ; do curl -s https://top-radio.org/$j/$i | htmlq .entry-title -a href a | uniq | cut -c23- >> A-$j.txt ; echo "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://top-radio.org/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | htmlq 'video > source' -a src | head -n 1 | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
