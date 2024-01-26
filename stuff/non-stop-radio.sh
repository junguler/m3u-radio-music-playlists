#!/bin/bash

# get a list of genres, countries, languages and networks
curl -s https://thenonstopradio.com/genre | htmlq -a href a | grep "/genre/" | sort | uniq | awk -F '/' '{print $5}' > genres.txt
curl -s https://thenonstopradio.com/country | htmlq -a href a | grep "/country/" | sort | uniq | awk -F '/' '{print $5}' > countries.txt
curl -s https://thenonstopradio.com/language | htmlq -a href a | grep "/language/" | sort | uniq | awk -F '/' '{print $5}' > languages.txt
curl -s https://thenonstopradio.com/network | htmlq -a href a | grep "/network/" | sort | uniq | awk -F '/' '{print $5}' > network.txt

# get the links to genres
for i in "" /{2..25} ; do for j in $(cat genres.txt) ; do curl -s https://thenonstopradio.com/genre/$j$i | htmlq -a href a | grep "/radio/" | uniq | awk -F '/' '{print $5}' >> A-$j.txt ; done ; done

# get the links to countires
for i in "" /{2..25} ; do for j in $(cat countries.txt) ; do curl -s https://thenonstopradio.com/country/$j$i | htmlq -a href a | grep "/radio/" | uniq | awk -F '/' '{print $5}' >> A-$j.txt ; done ; done

# get the links to languages
for i in "" /{2..25} ; do for j in $(cat languages.txt) ; do curl -s https://thenonstopradio.com/language/$j$i | htmlq -a href a | grep "/radio/" | uniq | awk -F '/' '{print $5}' >> A-$j.txt ; done ; done

# get the links to networks
for i in "" /{2..5} ; do for j in $(cat network.txt) ; do curl -s https://thenonstopradio.com/network/$j$i | htmlq -a href a | grep "/radio/" | uniq | awk -F '/' '{print $5}' >> A-$j.txt ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://thenonstopradio.com/radio/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep -oP 'data-audio-url="\K[^"]+' | awk NF | head -n 1 | sed 's|https://thenonstopradio.com/play?url=||g' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
