#!/bin/bash

# find genres and countries
curl -s https://radiotrucker.com/en/stations/ | htmlq \#selectorGenre option | awk -F '"' '{print $2}' | awk NF > genres.txt
curl -s https://radiotrucker.com/en/stations/ | htmlq \#selectorCountry option | awk -F '"' '{print $2}' | awk NF > countries.txt

# find pages for each category
for i in "" {2..5}/ ; do for j in $(cat genres.txt) ; do curl -s https://radiotrucker.com/en/stations/$j-stations/$i | htmlq -a href a | grep -v "radiotrucker" | sed -n 's|.*/en/stations/||p' | grep -v '/' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" {2..5}/ ; do for j in $(cat countries.txt) ; do curl -s https://radiotrucker.com/en/stations/$j-radios/$i | htmlq -a href a | grep -v "radiotrucker" | sed -n 's|.*/en/stations/||p' | grep -v '/' | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://radiotrucker.com/en/stations/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "var radio_info" | grep -oP 'stream: "\K[^"]+' | sed 's/\;//g' | sed '/^$/d' | xargs curl -s -I | grep "location" | awk '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
