#!/bin/bash

# find genres
curl -s https://escuchar.radio/generos | htmlq -a href a | grep "/genero/" | awk -F '/' '{print $5}' > genres.txt

# find pages for each category
for i in "" \?pagina={2..25} ; do for j in $(cat genres.txt) ; do curl -s https://escuchar.radio/genero/$j$i | htmlq .main-container -a href a | grep -v "genero\|pagina\|.com" | cut -c24- | grep -v "/" | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done
for i in "" \?pagina={2..25} ; do for j in "espana" "eeuu" "canada" ; do curl -s https://escuchar.radio/pais/$j$i | htmlq .main-container -a href a | grep -v "genero\|pagina\|.com" | cut -c24- | grep -v "/" | awk NF >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# scarpe the streams from each page
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://escuchar.radio/$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep "<source src=" | awk -F '"' '{print $2}' | head -n 1 | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
