#!/bin/bash

# get a list of genres, countries and languages
curl -s https://deso.fm/browse-genres | htmlq .radio-channels -a href a | awk -F '/' '{print $5}' > genres.txt
curl -s https://deso.fm/browse-countries | htmlq .radio-channels -a href a | awk -F '/' '{print $5}' > countries.txt
curl -s https://deso.fm/browse-languages | htmlq .radio-channels -a href a | awk -F '/' '{print $5}' > languages.txt

# get the links to genres
for i in "" \?page={2..50} ; do for j in $(cat genres.txt) ; do curl -s https://deso.fm/genre/$j$i | htmlq .radio-channels -a href a | awk -F '/' '{print $5}' >> A-$j.txt ; done ; done

# get the links to countires
for i in "" \?page={2..5} ; do for j in $(cat countries.txt) ; do curl -s https://deso.fm/country/$j$i | htmlq .radio-channels -a href a | awk -F '/' '{print $5}' >> A-$j.txt ; done ; done

# get the links to languages
for i in "" \?page={2..5} ; do for j in $(cat languages.txt) ; do curl -s https://deso.fm/language/$j$i | htmlq .radio-channels -a href a | awk -F '/' '{print $5}' >> A-$j.txt ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://deso.fm/listen/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "data-stream-url" | awk -F '"' '{print $6}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
