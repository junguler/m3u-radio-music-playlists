#!/bin/bash

# get a list of genres,and countries
curl -s https://www.liveradio.ie/genres | htmlq .content_main -a href a | awk -F '/' '{print $3}' | sed 's|genre-||g' > genres.txt
curl -s https://www.liveradio.ie/countries | htmlq .content_main -a href a | awk -F '/' '{print $3}' | sed 's|country-||g' > countries.txt

# get the links to genres
for i in "" /{2..25} ; do for j in $(cat genres.txt) ; do curl -s https://www.liveradio.ie/stations/genre-$j$i | htmlq -a href a | grep "ie/stations/" | uniq | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# get the links to countires
for i in "" /{2..25} ; do for j in $(cat countries.txt) ; do curl -s https://www.liveradio.ie/stations/country-$j$i | htmlq -a href a | grep "ie/stations/" | uniq | awk -F '/' '{print $5}' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://www.liveradio.ie/stations/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "mp3: " | awk -F "'" '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
